/**
 * The menu the status bar opens, and the menus behind it.
 *
 * It used to be a flat list of 29 rows, which is the same wall as the command
 * palette with icons on it. The top level is what you do while listening
 * plus five doors; everything else lives behind the door it belongs to, and
 * rows that would do nothing right now are not shown at all.
 *
 * Every one of these is a list of rows, and nothing else: what a row does
 * lives in the module that owns it, reached by its command or its function.
 * That is what keeps this file a table of contents rather than a program.
 */
import * as path from "path";
import * as vscode from "vscode";
import { config, RATE_MAX, RATE_MIN, saveVoiceRate } from "../core/config";
import { DEFAULT_KEEP_IN_SOURCE } from "../language/glossary";
import { languageName } from "../language/language";
import { runtime } from "../core/runtime";
import { playedAudio } from "../export/playedAudio";
import { newSpeechGroup, speakLine } from "../speech/speaking";
import { spokenMessages } from "../speech/spokenHistory";
import { lastSpoken } from "../speech/spokenHistory";
import { testCompletionSound } from "./sounds";
import { currentStateLine, fasterEngineHint, isSpeaking, updateStatus, voiceLabel } from "./statusBar";
import { menuLoop, MenuOutcome, MenuRow, runMenu, separator, pickWithBack } from "./prompts";
import { selectQwen3Model } from "./voicePickers";

/**
 * The one screen the status bar opens.
 *
 * It used to be a flat list of 29 rows, which is the same wall as the command
 * palette with icons on it. Now the top level is what you do while listening,
 * plus five doors; everything else lives behind the door it belongs to, and
 * rows that would do nothing right now (skip when silent, repeat with nothing
 * to repeat) are not shown at all.
 */
export async function showMenu(): Promise<void> {
  // The top level closes when something is picked, except when a submenu was
  // left with Escape, which brings this list back.
  for (;;) {
    if ((await showMenuOnce()) !== "ran") {
      return;
    }
  }
}

export async function showMenuOnce(): Promise<MenuOutcome> {
  const { enabled } = config();
  const paused = runtime.speech?.isPaused ?? false;
  const busy = isSpeaking();
  const rows: MenuRow[] = [
    {
      label: enabled ? "$(mute) Mute" : "$(unmute) Unmute",
      description: enabled ? "" : "currently muted",
      command: "claudeCodeTts.toggle",
      closeAfter: true,
    },
    ...(busy || paused
      ? [
          {
            label: paused ? "$(debug-start) Resume" : "$(debug-pause) Pause",
            description: "keeps the backlog",
            command: "claudeCodeTts.pauseResume",
            closeAfter: true,
          },
          { label: "$(debug-step-over) Skip this sentence", command: "claudeCodeTts.skip", closeAfter: true },
          {
            label: "$(stop-circle) Stop",
            description: "drops the backlog",
            command: "claudeCodeTts.stop",
            closeAfter: true,
          },
        ]
      : []),
    ...(lastSpoken().length > 0
      ? [{ label: "$(refresh) Repeat last message", command: "claudeCodeTts.repeatLast", closeAfter: true }]
      : []),
    { label: "$(clippy) Speak selection or clipboard", command: "claudeCodeTts.speak", closeAfter: true },
    ...(spokenMessages().length > 0
      ? [{ label: "$(history) Recent messages...", command: "claudeCodeTts.history", closeAfter: true, args: [true] }]
      : []),
    ...(playedAudio()?.has()
      ? [
          {
            label: "$(export) Export spoken audio...",
            detail: "The last message, or any part of what was played, as an MP3 or another file",
            command: "claudeCodeTts.exportAudio",
            args: [true],
          },
        ]
      : []),
    separator("Settings"),
    ...(config().speechConfig.engine === "system"
      ? [
          {
            label: "$(sparkle) Set up the best voice",
            detail: "One guided install: a voice worth listening to, and one you can make your own",
            command: "claudeCodeTts.setupBestVoice",
            closeAfter: true,
          },
        ]
      : []),
    { label: "$(record) Voice and speed...", detail: currentStateLine(), run: () => voiceAndSpeedMenu(true) },
    {
      label: "$(organization) My voices...",
      detail: "Record, design, rename, back up",
      command: "claudeCodeTts.manageVoices",
      args: [true],
    },
    { label: "$(globe) Languages and translation...", run: () => languagesMenu(true) },
    {
      label: "$(bell) Completion sounds...",
      detail: config().notifications.enabled ? "on" : "off",
      run: () => soundsMenu(true),
    },
    { label: "$(tools) Setup and diagnostics...", run: () => setupMenu(true) },
  ];
  return runMenu(rows, `Claude Code TTS: ${currentStateLine()}`);
}

export async function voiceAndSpeedMenuOnce(back: boolean): Promise<MenuOutcome> {
  const { speechConfig, listenTo } = config();
  return runMenu(
    [
      {
        label: "$(record) Select voice...",
        detail: speechConfig.voice ? voiceLabel(speechConfig.voice) : "the engine's default",
        command: "claudeCodeTts.selectVoice",
        args: [true],
      },
      {
        label: "$(chip) Choose voice engine...",
        detail: runtime.speech?.engineName ?? speechConfig.engine,
        command: "claudeCodeTts.selectEngine",
        args: [true],
      },
      ...(speechConfig.engine === "qwen3"
        ? [
            {
              label: "$(layers) Voice model...",
              detail: speechConfig.qwen3Model === "1.7B" ? "1.7B: larger, more natural" : "0.6B: smaller, faster",
              run: () => selectQwen3Model(true),
            },
          ]
        : []),
      {
        label: "$(dashboard) Set speech rate...",
        detail: `${speechConfig.rate} wpm`,
        command: "claudeCodeTts.selectRate",
        args: [true],
      },
      { label: "$(chevron-up) Speak faster", description: "+8%", command: "claudeCodeTts.rateUp" },
      { label: "$(chevron-down) Speak slower", description: "-8%", command: "claudeCodeTts.rateDown" },
      separator("What gets spoken"),
      {
        label:
          listenTo === "everywhere"
            ? "$(globe) Speaking: every session, terminals included"
            : "$(root-folder) Speaking: this window's folders only",
        detail:
          listenTo === "everywhere"
            ? `Sessions started with the claude command anywhere are spoken too${runtime.ownership?.isTerminalOwner() ? ", by this window" : " (another window is speaking those)"}`
            : "Only Claude Code sessions started in a folder this window has open",
        run: async () => {
          const c = vscode.workspace.getConfiguration("claudeCodeTts");
          const next = listenTo === "everywhere" ? "workspace" : "everywhere";
          await c.update("listenTo", next, vscode.ConfigurationTarget.Global);
          vscode.window.setStatusBarMessage(
            next === "everywhere"
              ? "Claude Code TTS: speaking every session, terminals included"
              : "Claude Code TTS: this window's folders only",
            3000
          );
        },
      },
      {
        label: "$(settings-gear) All speech settings...",
        run: () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:giladreich.claude-code-tts"),
      },
    ],
    `Voice and speed (${currentStateLine()})`,
    back
  );
}

export async function languagesMenuOnce(back: boolean): Promise<MenuOutcome> {
  const { speechConfig } = config();
  const target = speechConfig.speakLanguage;
  return runMenu(
    [
      {
        label: target
          ? `$(comment-discussion) Speaking everything in ${languageName(target)}`
          : "$(comment-discussion) Speak everything in one language...",
        detail: target
          ? "Change the language, or go back to speaking each message as written"
          : "Translates locally before speaking",
        command: "claudeCodeTts.setupTranslation",
        args: [true],
      },
      {
        label: "$(globe) Set the voice for a language...",
        detail: "Give one language its own voice, from any engine you have",
        command: "claudeCodeTts.languageVoice",
        args: [true],
      },
      {
        label: "$(symbol-keyword) Words to keep in English...",
        detail: `${keepInSourceTerms().length} terms are never translated (commit, build, pull request...)`,
        run: () =>
          vscode.commands.executeCommand("workbench.action.openSettings", "claudeCodeTts.keepInSourceLanguage"),
      },
    ],
    "Languages and translation",
    back
  );
}

/** The user's own glossary, or the built-in software one when they have none. */
export function keepInSourceTerms(): string[] {
  const own = vscode.workspace.getConfiguration("claudeCodeTts").get<string[]>("keepInSourceLanguage", []);
  return own.length > 0 ? own : DEFAULT_KEEP_IN_SOURCE;
}

export async function soundsMenuOnce(back: boolean): Promise<MenuOutcome> {
  const on = config().notifications.enabled;
  return runMenu(
    [
      {
        label: on ? "$(bell-slash) Turn completion sounds off" : "$(bell) Turn completion sounds on",
        detail: "Plays a sound when Claude finishes or needs you, in terminal sessions too",
        command: "claudeCodeTts.toggleNotifications",
      },
      ...(on
        ? [
            { label: "$(music) Choose the sounds...", command: "claudeCodeTts.configureSounds", args: [true] },
            {
              label: "$(play) Test the sound now",
              detail: "Runs the hook exactly as Claude Code runs it, and says what happened",
              run: testCompletionSound,
            },
          ]
        : []),
    ],
    "Completion sounds",
    back
  );
}

export async function setupMenuOnce(back: boolean): Promise<MenuOutcome> {
  return runMenu(
    [
      {
        label: "$(pulse) Check setup",
        detail: "What works on this machine, and how to fix what does not",
        command: "claudeCodeTts.checkSetup",
        args: [true],
      },
      {
        label: "$(database) Storage and cleanup...",
        detail: "See what the engines have downloaded and free what is unused",
        command: "claudeCodeTts.storage",
        args: [true],
      },
      { label: "$(output) Show spoken log", command: "claudeCodeTts.showLog", closeAfter: true },
      {
        label: "$(folder-opened) Open diagnostics folder",
        detail: "Daemon and player logs, for a bug report",
        run: () =>
          vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(path.join(runtime.context.globalStorageUri.fsPath, "player.log"))
          ),
      },
      separator("Settings"),
      {
        label: "$(settings-gear) All settings",
        run: () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:giladreich.claude-code-tts"),
      },
      { label: "$(discard) Reset settings to defaults...", command: "claudeCodeTts.resetSettings" },
      separator("Leaving"),
      {
        label: "$(trash) Remove everything Claude Code TTS added...",
        detail: "Hooks, models, logs and settings, with a voice backup first; then uninstall the extension",
        command: "claudeCodeTts.removeEverything",
      },
    ],
    "Setup and diagnostics",
    back
  );
}

export async function showHistory(back = false): Promise<MenuOutcome> {
  if (spokenMessages().length === 0) {
    vscode.window.showInformationMessage(
      "Claude Code TTS: no spoken messages recorded yet. Messages appear here once Claude produces prose output."
    );
    return back ? "back" : "closed";
  }
  const items = spokenMessages().map((h, i) => ({
    label: h.chunks[0].slice(0, 70) + (h.chunks[0].length > 70 ? "..." : ""),
    description: new Date(h.at).toLocaleString(),
    detail: h.chunks.join(" ").slice(0, 200),
    index: i,
  }));
  const picked = await pickWithBack(
    items,
    { placeHolder: "Re-speak a recent message (newest first)", title: "Recent messages", matchOnDetail: true },
    back
  );
  if (picked === "back") {
    return "back";
  }
  if (!picked) {
    return "closed";
  }
  runtime.speech?.stop();
  // Same path a live line takes, so an older message is repeated in the
  // language and voice you are listening in now.
  const group = newSpeechGroup();
  for (const chunk of spokenMessages()[picked.index].chunks) {
    speakLine(chunk, group);
  }
  return "ran";
}

/**
 * Speed steps are proportional (about 8%), so one keypress feels the same at
 * 120 wpm and at 400. The new rate is applied to the audio playing right now
 * before the setting is written, so the change is heard on the keypress
 * rather than after the configuration round trip.
 */
export async function adjustRate(direction: number): Promise<void> {
  // Step from the rate being heard, not the one in the settings. While speech
  // is catching up on a backlog it runs faster than the stored rate, and
  // stepping from the stored one made "faster" audibly slow it down.
  const setting = config().speechConfig.rate;
  const current = runtime.speech?.currentRate() ?? setting;
  const step = Math.max(10, Math.round(current * 0.08));
  const next = Math.max(RATE_MIN, Math.min(RATE_MAX, current + (direction > 0 ? step : -step)));
  if (next === setting) {
    vscode.window.setStatusBarMessage(`Claude Code TTS: already at ${setting} wpm`, 1500);
    return;
  }
  runtime.speech?.applyRateNow(next);
  updateStatus();
  const audible = runtime.speech?.audibleRate() ?? next;
  vscode.window.setStatusBarMessage(
    audible < next - 5
      ? `Claude Code TTS: ${next} wpm asked, about ${audible} possible: this engine synthesizes no faster. ${fasterEngineHint()}`
      : `Claude Code TTS: ${next} wpm`,
    5000
  );
  await saveVoiceRate(next);
}
const voiceAndSpeedMenu = (back = false): Promise<MenuOutcome> => menuLoop(voiceAndSpeedMenuOnce, back);

export const languagesMenu = (back = false): Promise<MenuOutcome> => menuLoop(languagesMenuOnce, back);
const soundsMenu = (back = false): Promise<MenuOutcome> => menuLoop(soundsMenuOnce, back);
const setupMenu = (back = false): Promise<MenuOutcome> => menuLoop(setupMenuOnce, back);
