/**
 * Completion sounds, as a person sets them up.
 *
 * The sounds are played by a script Claude Code runs (see
 * src/setup/notifySetup.ts and assets/notify.js); this is the part someone
 * touches: which event makes which sound, which tools count as a tool run,
 * whether it works at all, and the hooks written on the first activation.
 */
import * as fs from "fs";
import * as vscode from "vscode";
import { config, DEFAULT_SOUNDS } from "../core/config";
import { hooksInstalled, installHooksNow, listSystemSounds, notifyScriptPath, soundPath } from "../setup/notifySetup";
import { runtime } from "../core/runtime";
import { livePreviewPicker, MenuOutcome, pickManyWithBack } from "./prompts";

/** Set once the completion-sound hooks have been installed and announced. */
const HOOKS_KEY = "claudeCodeTts.hooksAnnounced";

/**
 * Install the completion-sound hooks on a machine that has never had them,
 * and say so once. Silent installation of a file outside the editor would be
 * the wrong kind of helpful, so the notice names what changed and offers the
 * switch that undoes it; it is shown once per installation.
 */
export async function installDefaultHooks(): Promise<void> {
  if (hooksInstalled(runtime.context)) {
    return;
  }
  installHooksNow(runtime.context, config().notifications);
  if (runtime.context.globalState.get<boolean>(HOOKS_KEY)) {
    return;
  }
  await runtime.context.globalState.update(HOOKS_KEY, true);
  const pick = await vscode.window.showInformationMessage(
    "Claude Code TTS plays a sound when Claude finishes or needs you, through Claude Code's own hooks, so it works in terminal sessions with VSCode closed. It added them to ~/.claude/settings.json, and removes them when this extension is uninstalled.",
    "Sounds off",
    "Choose sounds"
  );
  if (pick === "Sounds off") {
    await vscode.commands.executeCommand("claudeCodeTts.toggleNotifications");
  } else if (pick === "Choose sounds") {
    await vscode.commands.executeCommand("claudeCodeTts.configureSounds");
  }
}

/**
 * Play the finished sound the way Claude Code will.
 *
 * Sounds go through a script that Claude Code runs, not through this process,
 * so "I stopped hearing them" has several possible answers and no way to tell
 * them apart from the outside: the hooks removed from Claude Code's settings,
 * the script missing, the sound set to nothing, a player that is not there.
 * This runs the real script the real way and reports which of those it is.
 */
export async function testCompletionSound(): Promise<void> {
  const script = notifyScriptPath(runtime.context);
  if (!hooksInstalled(runtime.context) || !fs.existsSync(script)) {
    const FIX = "Install them again";
    const pick = await vscode.window.showWarningMessage(
      "Claude Code TTS: the completion-sound hooks are not in Claude Code's settings, so nothing would play.",
      FIX
    );
    if (pick === FIX) {
      try {
        installHooksNow(runtime.context, config().notifications);
        vscode.window.showInformationMessage("Claude Code TTS: the hooks are back in ~/.claude/settings.json.");
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Code TTS: ${(e as Error).message}`);
      }
    }
    return;
  }
  const sound = config().notifications.sounds?.stop;
  if (!sound) {
    vscode.window.showInformationMessage(
      'Claude Code TTS: the finished sound is set to off, so nothing plays. "Choose the sounds" sets one.'
    );
    return;
  }
  const { spawn } = await import("child_process");
  const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
    // The editor's own runtime runs it: a GUI-launched editor often has no
    // node on PATH, which is the very thing that broke these sounds.
    const child = spawn(process.execPath, [script, "stop"], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => (err += String(d)));
    child.on("error", (e: Error) => resolve({ code: -1, err: e.message }));
    child.on("close", (code: number | null) => resolve({ code, err }));
    child.stdin?.end("{}");
  });
  runtime.output.appendLine(`[sounds] test: exit ${result.code}${result.err ? ` ${result.err.trim()}` : ""}`);
  if (result.code === 0 && !result.err) {
    vscode.window.setStatusBarMessage(
      `Claude Code TTS: played ${sound}. If you heard nothing, the sound or the volume is the thing to change.`,
      6000
    );
  } else {
    vscode.window
      .showErrorMessage(
        `Claude Code TTS: the sound script failed (${result.err.trim() || `exit ${result.code}`}).`,
        "Show log"
      )
      .then((pick) => pick && runtime.output.show());
  }
}

export const SOUND_CATEGORIES = [
  { event: "done", label: "Done", detail: "Claude finished its turn" },
  { event: "permission", label: "Permission needed", detail: "Claude is blocked waiting for your approval" },
  { event: "question", label: "Question asked", detail: "Claude asked you a question" },
  { event: "waiting", label: "Waiting for you", detail: "Idle reminder that Claude awaits input" },
  {
    event: "tool",
    label: "Tool runs",
    detail: "Claude runs a watched tool (e.g. Bash under auto-approve); pick which tools next",
  },
  {
    event: "subagent",
    label: "Subagent finished",
    detail: "A background agent completed (off by default; can be chatty)",
  },
  {
    event: "prompt",
    label: "Prompt received",
    detail: "Short tick confirming Claude got your prompt (off by default)",
  },
];
const COMMON_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Skill"];

/**
 * Change one event's sound, keeping the rest of the object as it is.
 *
 * Silence is stored as an empty string rather than as a missing key, and
 * that is not a style choice: VSCode merges an object setting key by key
 * over the default declared in package.json, so a key the user removes comes
 * straight back from the default and the event keeps sounding. An empty
 * string is a value, and a value replaces the default.
 */
export async function setSound(kind: string, sound: string): Promise<void> {
  // Fetched here, never passed in: a WorkspaceConfiguration is a snapshot of
  // the settings as they were when it was taken. Building the map from a
  // snapshot taken before the previous change dropped that change, and
  // reading a description from one made a sound just set read as "off".
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  const current = { ...c.get<Record<string, string>>("notifications.sounds", DEFAULT_SOUNDS), [kind]: sound };
  await c.update("notifications.sounds", current, vscode.ConfigurationTarget.Global);
}

export async function pickToolFilter(): Promise<void> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  const current = c.get<string[]>("notifications.toolFilter", ["Bash"]);
  const all = [...new Set([...COMMON_TOOLS, ...current])];
  const picked = await pickManyWithBack({
    items: all.map((t) => ({ label: t, picked: current.includes(t) })),
    placeholder: "Which tools should ding when Claude runs them? (space to tick, Enter to confirm)",
    title: "Tools that make a sound",
    back: true,
  });
  if (!picked || picked === "back") {
    return;
  }
  await c.update(
    "notifications.toolFilter",
    picked.map((p) => p.label),
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Which sound plays for which event.
 *
 * Two lists, and both of them play what they are describing: the events list
 * plays the sound that event has now, so "which one is the tool ding again?"
 * is answered by arrowing onto the row rather than by opening it. Choosing a
 * sound returns here rather than closing, because whoever changes one of
 * these usually changes the next one too.
 */
export async function configureSounds(back = false): Promise<MenuOutcome> {
  if (listSystemSounds().length === 0) {
    vscode.window.showInformationMessage(
      "Claude Code TTS: no system sound library was found on this machine, so sounds cannot be auditioned here. An event can still be silenced by setting it to an empty string in claudeCodeTts.notifications.sounds."
    );
    return back ? "back" : "closed";
  }
  for (;;) {
    // Read again every time round: this list is shown after a change was
    // made through it, and a snapshot from before that change showed the
    // sound just chosen as "off".
    const settings = vscode.workspace.getConfiguration("claudeCodeTts");
    const configured = settings.get<Record<string, string>>("notifications.sounds", DEFAULT_SOUNDS);
    // A tool sound with no tools chosen is a sound that never plays, which
    // reads as a broken setting rather than an empty list.
    const tools = settings.get<string[]>("notifications.toolFilter", ["Bash"]);
    const describeSound = (event: string): string => {
      const sound = configured[event];
      if (!sound) {
        return "off";
      }
      return event === "tool"
        ? `${sound} (${tools.length ? tools.join(", ") : "no tools chosen, so it never plays"})`
        : sound;
    };
    let chosen: (typeof SOUND_CATEGORIES)[number] | undefined;
    const outcome = await livePreviewPicker({
      items: SOUND_CATEGORIES.map((s) => ({
        label: s.label,
        description: describeSound(s.event),
        detail: s.detail,
        event: s.event,
      })),
      placeholder: "Highlight an event to hear its sound; Enter changes it",
      title: "Completion sounds",
      back,
      matchOnDetail: true,
      debounceMs: 200,
      sample: (item) => {
        const file = soundPath(configured[item.event] ?? "");
        return file ? { text: "", voice: "", file, volume: config().notifications.volume } : undefined;
      },
      accept: (item) => {
        chosen = SOUND_CATEGORIES.find((s) => s.event === item.event);
      },
    });
    if (outcome !== "ran" || !chosen) {
      return outcome;
    }
    await pickSoundFor(chosen);
  }
}

/** The sound list for one event. Escape returns to the list of events. */
export async function pickSoundFor(category: (typeof SOUND_CATEGORIES)[number]): Promise<void> {
  const current =
    vscode.workspace
      .getConfiguration("claudeCodeTts")
      .get<Record<string, string>>("notifications.sounds", DEFAULT_SOUNDS)[category.event] ?? "";
  const OFF = "(off)";
  await livePreviewPicker({
    items: [
      { label: OFF, description: current === "" ? "current" : "", detail: "No sound for this event" },
      ...listSystemSounds().map((name) => ({
        label: name,
        description: name === current ? "current" : "",
        detail: "",
      })),
    ],
    placeholder: `${category.label}: highlight a sound to hear it; Enter selects`,
    title: `Completion sounds: ${category.label}`,
    back: true,
    debounceMs: 200,
    sample: (item) => {
      const file = item.label === OFF ? undefined : soundPath(item.label);
      return file ? { text: "", voice: "", file, volume: config().notifications.volume } : undefined;
    },
    accept: async (item) => {
      await setSound(category.event, item.label === OFF ? "" : item.label);
      // The notifications config-change handler syncs the hook config file.
      // For the tool category, follow up with the which-tools multi-select.
      if (category.event === "tool" && item.label !== OFF) {
        await pickToolFilter();
      }
    },
  });
}
