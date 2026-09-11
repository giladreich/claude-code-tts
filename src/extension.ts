import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { applySubstitutions, utterancesFromLine } from "./speech/format";
import { filterUtterances } from "./speech/utteranceFilter";
import { disposePersistentPlayer, initPersistentPlayer } from "./tts/audio";
import { cleanupStaleTempFiles, setPipelineLogger } from "./tts/synthPlay";
import {
  demoSound,
  ensureHooksCurrent,
  hooksInstalled,
  installHooks,
  removeHooks,
  syncNotifyRuntime,
} from "./setup/notifySetup";
import { setExtraUvToolsDir } from "./platform/platform";
import { NUDGE_AFTER, shouldNudge } from "./setup/onboarding";
import * as os from "os";
import { clipboardTarget } from "./session/selection";
import { defaultArgosDir, defaultExtensionsDir, defaultHfHome, ScanOptions } from "./platform/storage";
import { exportVoicesFlow, importVoicesFlow, storageFlow, StorageUiDeps } from "./ui/storageUi";
import { SpeechQueue } from "./speech/speech";
import { projectDirName, PROJECTS_DIR, TranscriptTailer, encodeProjectDir, sameProjectDir } from "./session/tailer";
import { chatterboxReady, resolveChatterboxRuntime, TEXT_PREP_NEEDED } from "./tts/chatterbox";
import { privateUvToolsDir } from "./platform/uvBootstrap";
import { kokoroReady } from "./tts/kokoro";
import { piperAvailable } from "./tts/piper";
import { cloneVoiceFlow } from "./voices/clone";
import { cloneFromFileFlow } from "./voices/cloneFromFile";
import { designVoiceFlow } from "./voices/design";
import { manageVoicesFlow } from "./ui/voiceManager";
import { isCloneVoice, listQwen3Clones, qwen3Available, qwen3VoicesDir, resolveQwen3Runtime } from "./tts/qwen3";
import { migrateSettings, PREVIOUS_SECTION } from "./core/settingsMigration";
import { projectLabel, registryDir, SessionOwnership } from "./session/sessionOwnership";
import { ControlCommand, ControlWatcher } from "./session/control";
import { anyFetching, hubDir } from "./platform/modelProgress";
import { runtime } from "./core/runtime";
import { lastSpoken, loadHistory, recordMessage } from "./speech/spokenHistory";
import { adjustRate, languagesMenu, showHistory, showMenu } from "./ui/menus";
import { downloadVoiceForLanguage } from "./language/languageSupport";
import { newTranslator } from "./language/translationSetup";
import {
  offerDirectLanguages,
  offerReVoicedLanguage,
  offerToSpeakProfileLanguage,
  suggestQwen3For,
  useNewProfile,
} from "./voices/voiceOffers";
import {
  lastTool,
  speakTarget,
  projectChanged,
  speakLine,
  speakSelectionOrClipboard,
  toolNames,
  translating,
} from "./speech/speaking";
import { selectEngine, selectRate, selectVoice } from "./ui/voicePickers";
import {
  notifyLanguageUnsupported,
  notifyRouted,
  setLanguageVoice,
  setupTranslationFlow,
} from "./language/languageFlows";
import { activateVoiceProfile, currentProfileVoice, profileFor } from "./voices/voiceProfiles";
import {
  checkSetupFlow,
  downloadVoiceFlow,
  ensureChatterboxText,
  ensureVoiceEngine,
  offerBetterVoice,
  prepareTextFor,
  setupBestVoiceFlow,
  setupChatterboxFlow,
  setupKokoroFlow,
  setupQwen3Flow,
} from "./setup/setupFlows";
import { clearAllSettings, removeEverythingFlow } from "./setup/uninstall";
import {
  noteSpeaking,
  stopWatchingDownloads,
  trackEngineReady,
  updateStatus,
  watchModelDownload,
} from "./ui/statusBar";
import { configureSounds, installDefaultHooks } from "./ui/sounds";
import { SETTING_KEYS, chunkPlanFor, config, saveVoiceRate } from "./core/config";

let lastEngineWarningAt = 0;
/** Set once the first-run greeting has been shown. */
const WELCOMED_KEY = "claudeCodeTts.welcomed";
/** Utterances spoken on this machine, and whether a better voice was offered. */
const SPOKEN_KEY = "claudeCodeTts.spokenCount";
const NUDGED_KEY = "claudeCodeTts.offeredBetterVoice";

/**
 * Settings that were renamed or merged keep working. Runs once at activation
 * and writes nothing when there is nothing old to carry.
 */
async function carryOldSettingsForward(): Promise<void> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  const was = vscode.workspace.getConfiguration(PREVIOUS_SECTION);
  const section = (config: vscode.WorkspaceConfiguration) => ({
    inspect: (key: string) => config.inspect(key),
    update: (key: string, value: unknown, global: boolean) =>
      Promise.resolve(
        config.update(key, value, global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace)
      ).then(() => undefined),
  });
  try {
    const { merged, cleared, moved } = await migrateSettings(
      { ...section(c), previousSection: section(was) },
      SETTING_KEYS
    );
    if (moved.length) {
      runtime.output.appendLine(`[settings] carried over from the previous name: ${moved.join(", ")}`);
    }
    if (merged.length) {
      runtime.output.appendLine(`[settings] carried forward: ${merged.join(", ")}`);
    }
    if (cleared.length) {
      runtime.output.appendLine(`[settings] no longer settings, cleared: ${cleared.join(", ")}`);
    }
  } catch (e) {
    runtime.output.appendLine(`[settings] migration skipped: ${(e as Error).message}`);
  }
}

/**
 * The first thing a new user sees, and the only thing an existing one sees
 * when something is actually wrong.
 *
 * Five warnings used to fire at activation, in every window, at every launch,
 * with no memory: opening three windows meant three identical popups about a
 * missing engine. Now the selected engine is checked once per problem (the
 * notice returns if it is fixed and breaks again), and a machine where
 * everything works gets a greeting on the first run and silence afterwards.
 */
async function greetOrWarn(): Promise<void> {
  const cfg = config().speechConfig;
  const seen = runtime.context.globalState;

  const problem = (): { id: string; message: string; action: string; command: string } | undefined => {
    if (cfg.engine === "piper" && !piperAvailable(cfg.piperPath)) {
      return {
        id: "piper-missing",
        message: "Piper is the selected engine but is not installed.",
        action: "Install Piper",
        command: "claudeCodeTts.downloadVoice",
      };
    }
    if (cfg.engine === "piper" && !cfg.voice) {
      return {
        id: "piper-no-voice",
        message: "Piper is selected but no voice model is set.",
        action: "Download a voice",
        command: "claudeCodeTts.downloadVoice",
      };
    }
    if (cfg.engine === "qwen3" && !qwen3Available()) {
      return {
        id: "qwen3",
        message: "Qwen3 is selected but its runtime is not installed.",
        action: "Set up Qwen3",
        command: "claudeCodeTts.setupQwen3",
      };
    }
    if (cfg.engine === "kokoro" && !kokoroReady(cfg.kokoroDir)) {
      return {
        id: "kokoro",
        message: "Kokoro is selected but not downloaded yet.",
        action: "Set up Kokoro",
        command: "claudeCodeTts.setupKokoro",
      };
    }
    if (cfg.engine === "chatterbox" && !chatterboxReady(runtime.context.globalStorageUri.fsPath)) {
      return {
        id: "chatterbox",
        message: "Chatterbox is selected but not installed yet.",
        action: "Set up Chatterbox",
        command: "claudeCodeTts.setupChatterbox",
      };
    }
    return undefined;
  };

  // Nothing to speak at all: this extension reads what Claude Code writes,
  // and on a machine without it there is no directory to watch. Saying so
  // once is better than a greeting that promises speech and then silence.
  if (!fs.existsSync(PROJECTS_DIR)) {
    if (seen.get<boolean>("warned:no-claude-code")) {
      return;
    }
    await seen.update("warned:no-claude-code", true);
    const pick = await vscode.window.showInformationMessage(
      "Claude Code TTS reads what Claude Code writes, and Claude Code does not seem to be installed on this machine. Once it has run once, its output will be spoken here.",
      "How to install Claude Code"
    );
    if (pick) {
      await vscode.env.openExternal(vscode.Uri.parse("https://claude.com/claude-code"));
    }
    return;
  }

  const trouble = problem();
  if (trouble) {
    // Once per problem: told, fixed, and told again only if it comes back.
    const key = `warned:${cfg.engine}:${trouble.id}`;
    if (seen.get<boolean>(key)) {
      return;
    }
    await seen.update(key, true);
    const pick = await vscode.window.showWarningMessage(
      `Claude Code TTS: ${trouble.message}`,
      trouble.action,
      "Use the system voice"
    );
    if (pick === trouble.action) {
      await vscode.commands.executeCommand(trouble.command);
    } else if (pick === "Use the system voice") {
      await vscode.workspace
        .getConfiguration("claudeCodeTts")
        .update("engine", "system", vscode.ConfigurationTarget.Global);
    }
    return;
  }
  // The engine works, so clear the notices about it: if it breaks later, say so again.
  for (const key of seen.keys?.() ?? []) {
    if (key.startsWith(`warned:${cfg.engine}:`)) {
      await seen.update(key, undefined);
    }
  }

  if (seen.get<boolean>(WELCOMED_KEY)) {
    return;
  }
  await seen.update(WELCOMED_KEY, true);
  const pick = await vscode.window.showInformationMessage(
    "Claude Code TTS is listening: Claude Code's replies will be read aloud, on this machine only. It starts with the voice this computer already has, which sounds like one. " +
      "One guided install replaces it with a voice worth listening to, and one you can make your own.",
    "Set up the best voice",
    "Hear it first",
    "Show me around"
  );
  if (pick === "Set up the best voice") {
    await setupBestVoiceFlow();
  } else if (pick === "Hear it first") {
    runtime.speech?.enqueue(
      "This is the voice your computer came with. The menu in the status bar sets up a better one."
    );
  } else if (pick === "Show me around") {
    await vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "giladreich.claude-code-tts#claudeCodeTts.gettingStarted",
      false
    );
  }
}

/**
 * Counting what has been spoken, so that someone who has heard fifty
 * utterances of the built-in voice is told once that it does not have to
 * sound like that. Batched: this runs on every sentence, and globalState is
 * a disk write.
 */
let spokenSinceStore = 0;

function countSpoken(n: number): void {
  if (n <= 0 || !runtime.context) {
    return;
  }
  spokenSinceStore += n;
  if (spokenSinceStore < 10) {
    return;
  }
  const spoken = (runtime.context.globalState.get<number>(SPOKEN_KEY) ?? 0) + spokenSinceStore;
  spokenSinceStore = 0;
  void runtime.context.globalState.update(SPOKEN_KEY, spoken);
  const state = {
    engine: config().speechConfig.engine,
    spoken,
    nudged: runtime.context.globalState.get<boolean>(NUDGED_KEY) === true,
  };
  if (shouldNudge(state, NUDGE_AFTER)) {
    background("offer a better voice", offerBetterVoice);
  }
}

/**
 * A command written to the control file. Every window obeys what applies to
 * it: muting is global by nature, and skipping only does anything in the
 * window that is speaking.
 */
async function runControlCommand(command: ControlCommand): Promise<void> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  runtime.output.appendLine(`[control] ${command.verb}${command.rate ? ` ${command.rate}` : ""}`);
  switch (command.verb) {
    case "mute":
    case "unmute":
    case "toggle": {
      const enabled = c.get<boolean>("enabled", true);
      const next = command.verb === "toggle" ? !enabled : command.verb === "unmute";
      if (next === enabled) {
        return;
      }
      if (!next) {
        runtime.speech?.stop();
      }
      await c.update("enabled", next, vscode.ConfigurationTarget.Global);
      updateStatus();
      return;
    }
    case "pause":
      runtime.speech?.pause();
      return void updateStatus();
    case "resume":
      runtime.speech?.resume();
      return void updateStatus();
    case "skip":
      return runtime.speech?.skip();
    case "stop":
      return runtime.speech?.stop();
    case "repeat":
      return void vscode.commands.executeCommand("claudeCodeTts.repeatLast");
    case "faster":
      if (command.rate) {
        runtime.speech?.applyRateNow(command.rate);
        updateStatus();
        return saveVoiceRate(command.rate);
      }
      return void adjustRate(1);
    case "slower":
      return void adjustRate(-1);
  }
}

/**
 * Run something in the background and put a failure in the log rather than
 * in the extension host's unhandled-rejection channel, where nobody sees it
 * and VSCode reports it as an extension crash.
 */
function background(what: string, run: () => Promise<unknown>): void {
  void Promise.resolve()
    .then(run)
    .catch((e) => runtime.output.appendLine(`[error] ${what}: ${(e as Error)?.message ?? e}`));
}

function workspaceProjectDirNames(): Set<string> {
  const names = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === "file") {
      names.add(encodeProjectDir(folder.uri.fsPath));
    }
  }
  return names;
}

async function resetSettings(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Reset all Claude Code TTS settings to their defaults? This clears the selected voice, rate, filters, and every other claudeCodeTts.* setting.",
    { modal: true },
    "Reset"
  );
  if (choice !== "Reset") {
    return;
  }
  await clearAllSettings();
  runtime.speech?.setConfig(config().speechConfig);
  runtime.speech?.enqueue("Claude Code TTS settings reset to defaults.");
  updateStatus();
}

// ------------------------------ disk space ------------------------------

function scanOptions(): ScanOptions {
  const c = config().speechConfig;
  return {
    storageDir: runtime.context.globalStorageUri.fsPath,
    // Stated rather than defaulted inside the scanner: it lists what may be
    // deleted, so every directory it looks at is named by its caller.
    hfHome: defaultHfHome(),
    extensionsDir: defaultExtensionsDir(),
    argosDir: defaultArgosDir(),
    engine: c.engine,
    qwen3Model: c.qwen3Model,
    qwen3Voice: c.voice,
    piperVoice:
      c.engine === "piper"
        ? c.voice
        : vscode.workspace.getConfiguration("claudeCodeTts").get<string>("piper.voice", ""),
    kokoroVoice: c.engine === "kokoro" ? c.voice : "",
    qwen3Runtime: resolveQwen3Runtime(c.qwen3Runtime),
    chatterboxRuntime: resolveChatterboxRuntime(runtime.context.globalStorageUri.fsPath, c.chatterboxRuntime),
    tmpDir: os.tmpdir(),
    speakLanguage: c.speakLanguage,
  };
}

/** Restart the engine after its model files were removed. */
function rebuildEngine(): void {
  // Was: set a fake value into qwen3Style and set it back, so that the
  // settings comparison saw an engine change. That trick stopped working
  // when the per-request settings became live, and took the loudness, pace
  // and re-recorded references of Manage Voices with it.
  runtime.speech?.stop();
  runtime.speech?.rebuild();
  trackEngineReady();
}

function storageDeps(): StorageUiDeps {
  return {
    context: runtime.context,
    scanOptions,
    rebuildEngine,
    log: (m) => runtime.output.appendLine(m),
    enqueue: (t) => runtime.speech?.enqueue(t),
    useVoice: async (value) => {
      if (!(await ensureVoiceEngine("Speaking in a voice you made"))) {
        return;
      }
      await activateVoiceProfile(value);
      runtime.speech?.enqueue("This voice is active now.");
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  runtime.context = context;
  // Tools installed through the extension's own uv live in its storage;
  // register that directory before anything looks for a Python runtime.
  setExtraUvToolsDir(privateUvToolsDir(context.globalStorageUri.fsPath));
  runtime.output = vscode.window.createOutputChannel("Claude Code TTS");
  background("settings migration", () => carryOldSettingsForward());
  runtime.onError = (msg: string) => {
    runtime.output.appendLine(`[error] ${msg}`);
    if (msg.startsWith(TEXT_PREP_NEEDED)) {
      // The words being spoken are not the words that were written, and one
      // install fixes it: this is not a log line, it is a question.
      const ADD = "Add it";
      vscode.window
        .showWarningMessage(`Claude Code TTS: ${msg.slice(TEXT_PREP_NEEDED.length)}`, ADD, "Not now")
        .then((pick) => {
          if (pick === ADD) {
            void ensureChatterboxText();
          }
        });
      return;
    }
    // Engine failures must not be silent: surface daemon/setup problems once a minute.
    if (
      /daemon|not set up|synthesis failed|no WAV player|playback|no built-in voice/i.test(msg) &&
      Date.now() - lastEngineWarningAt > 60_000
    ) {
      lastEngineWarningAt = Date.now();
      vscode.window
        .showWarningMessage(`Claude Code TTS: ${msg}`, "Show log")
        .then((pick) => pick && runtime.output.show());
    }
  };
  loadHistory();
  // Low-latency playback: compile the bundled Swift player once, in the
  // background; afplay serves until (and unless) it is ready.
  initPersistentPlayer(
    context.globalStorageUri.fsPath,
    path.join(context.extensionPath, "assets", "wavplayer.swift"),
    runtime.onError
  );
  cleanupStaleTempFiles();
  runtime.translator = newTranslator();
  context.subscriptions.push({ dispose: () => runtime.translator?.dispose() });
  if (config().speechConfig.speakLanguage) {
    runtime.translator?.prewarm(config().speechConfig.speakLanguage);
  }
  setPipelineLogger((m) => runtime.output.appendLine(`[audio] ${m}`));
  // Keep the hook script, hook entries, and config current across updates,
  // and install them the first time: completion sounds are on by default, and
  // they only work through Claude Code's own hooks. The script removes them
  // again when it finds this extension uninstalled.
  if (config().notifications.enabled) {
    syncNotifyRuntime(context, config().notifications, runtime.onError);
    if (hooksInstalled(context)) {
      ensureHooksCurrent(context, config().notifications);
    } else {
      background("completion sounds", () => installDefaultHooks());
    }
  }
  background("language offer", () => offerDirectLanguages());

  runtime.speech = new SpeechQueue(
    config().speechConfig,
    runtime.onError,
    (playing) => {
      noteSpeaking(playing);
      updateStatus();
    },
    undefined,
    (language) => void notifyLanguageUnsupported(language),
    (language, engine, voice) => notifyRouted(language, engine, voice)
  );
  if (!runtime.speech.hasEngine) {
    vscode.window.showWarningMessage(
      "Claude Code TTS: no text-to-speech engine found. On Linux install espeak-ng; macOS and Windows use built-in engines."
    );
  }
  background("first run", () => greetOrWarn());
  // A window reloaded mid-download would otherwise show nothing until the
  // next engine switch, which is exactly when someone asks whether it hung.
  background("model download", async () => {
    if (anyFetching(hubDir())) {
      watchModelDownload();
    }
  });

  let scopedDirs = workspaceProjectDirNames();
  const mine = (projectDirName: string): boolean => [...scopedDirs].some((d) => sameProjectDir(d, projectDirName));

  // Sessions started in a terminal belong to no window, so without a rule
  // every open window would speak them at once. The registry decides: each
  // window speaks its own folders, and the window open longest speaks the
  // rest. See src/session/sessionOwnership.ts.
  runtime.ownership = new SessionOwnership({
    dir: registryDir(context.globalStorageUri.fsPath),
    dirs: () => [...scopedDirs],
  });
  runtime.ownership.start();
  context.subscriptions.push({ dispose: () => runtime.ownership?.dispose() });

  // A terminal is often where the user is when they want the voice to stop.
  runtime.control = new ControlWatcher((command) => background("control command", () => runControlCommand(command)));
  runtime.control.start();
  context.subscriptions.push({ dispose: () => runtime.control?.dispose() });

  const inScope = (projectDirName: string): boolean =>
    config().listenTo === "workspace" ? mine(projectDirName) : runtime.ownership!.owns(projectDirName);

  runtime.tailer = new TranscriptTailer(
    (line, file) => {
      const cfg = config();
      // An assistant line means Claude is speaking and audio may be seconds
      // away. An unloaded Chatterbox takes 16 s to load, so it starts now
      // rather than after the first sentence is already waiting. Cheap when
      // the model is loaded (the call returns at once). Only assistant lines
      // count: a session writes user, tool-result and meta lines all the
      // time, and waking on those defeated the idle unload entirely, keeping
      // 3 GB resident for a window that was never going to say anything.
      if (
        cfg.enabled &&
        !(cfg.onlyWhenUnfocused && vscode.window.state.focused) &&
        line.includes('"type":"assistant"')
      ) {
        runtime.speech?.wake();
      }
      // Parse even while muted so tool-name correlation for errors stays warm.
      const utterances = utterancesFromLine(
        line,
        {
          speakText: cfg.speakText,
          speakTools: cfg.speakTools,
          speakErrors: cfg.speakErrors,
          speakSubagents: cfg.speakSubagents,
          // Neural engines ramp: a small first chunk gets audio out fast,
          // larger later chunks keep prosody. System voices stay uniform.
          // When translating, prose stays in whole blocks here (only the
          // opening clause is split off, so the first words are not delayed
          // by translating the whole paragraph) and is chunked after
          // translation in speakLine().
          chunkChars: translating()
            ? Number.MAX_SAFE_INTEGER
            : chunkPlanFor(cfg.speechConfig.engine, cfg.speechConfig.qwen3Model),
          // With speech already queued, the opening clause split buys no
          // latency and costs prosody: keep whole sentences then.
          fastStart: (runtime.speech?.pending ?? 0) === 0,
        },
        toolNames
      );
      if (utterances.length === 0) {
        return;
      }

      const prose = utterances.filter((u) => u.kind === "text").map((u) => u.text);
      if (prose.length > 0) {
        recordMessage(prose);
      }

      if (!cfg.enabled) {
        return;
      }
      if (cfg.onlyWhenUnfocused && vscode.window.state.focused) {
        return;
      }
      if (cfg.interruptOnNew && prose.length > 0) {
        runtime.speech?.stop();
      }

      // Following more than one session at once, you need to know whose
      // voice you are hearing. Only when it changes, and never for this
      // window's own project, which is the one you are looking at.
      const project = projectDirName(file);
      const speakable = filterUtterances(utterances, cfg, lastTool, Date.now());
      if (speakable.length > 0) {
        const { changed, previous } = projectChanged(project);
        if (changed && previous && !mine(project)) {
          speakLine(`From ${projectLabel(project)}.`);
        }
      }
      for (const u of speakable) {
        const text = applySubstitutions(u.text, cfg.substitutions);
        runtime.output.appendLine(`[speak ${u.kind} @${runtime.speech!.currentRate()}wpm] ${text}`);
        speakLine(text);
      }
      countSpoken(speakable.length);
      updateStatus();
    },
    runtime.onError,
    inScope
  );
  runtime.tailer.start();

  runtime.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  runtime.statusItem.command = "claudeCodeTts.menu";
  updateStatus();
  runtime.statusItem.show();
  trackEngineReady(); // needs the status bar item to exist

  context.subscriptions.push(
    runtime.output,
    runtime.statusItem,
    { dispose: () => runtime.speech?.dispose() },
    { dispose: () => runtime.tailer?.dispose() },
    { dispose: disposePersistentPlayer },
    vscode.commands.registerCommand("claudeCodeTts.toggle", async () => {
      const c = vscode.workspace.getConfiguration("claudeCodeTts");
      const next = !c.get<boolean>("enabled", true);
      // Muting must silence instantly: kill current audio and drop the queue.
      // While muted the tailer keeps consuming lines, so unmuting resumes
      // from whatever Claude writes next, not from the old backlog.
      if (!next) {
        runtime.speech?.stop();
      }
      await c.update("enabled", next, vscode.ConfigurationTarget.Global);
      if (next) {
        // Unmuting must be audible, not held by an old pause
        if (runtime.speech?.isPaused) {
          runtime.speech.resume();
        }
        runtime.speech?.enqueue("Voice on");
      }
      updateStatus();
    }),
    vscode.commands.registerCommand("claudeCodeTts.stop", () => {
      runtime.speech?.stop();
      updateStatus();
    }),
    vscode.commands.registerCommand("claudeCodeTts.skip", () => runtime.speech?.skip()),
    vscode.commands.registerCommand("claudeCodeTts.pauseResume", () => {
      if (runtime.speech?.isPaused) {
        runtime.speech.resume();
      } else {
        runtime.speech?.pause();
      }
      updateStatus();
    }),
    vscode.commands.registerCommand("claudeCodeTts.rateUp", () => adjustRate(20)),
    vscode.commands.registerCommand("claudeCodeTts.rateDown", () => adjustRate(-20)),
    vscode.commands.registerCommand("claudeCodeTts.selectVoice", selectVoice),
    vscode.commands.registerCommand("claudeCodeTts.selectEngine", selectEngine),
    vscode.commands.registerCommand("claudeCodeTts.setupKokoro", setupKokoroFlow),
    vscode.commands.registerCommand("claudeCodeTts.setupBestVoice", setupBestVoiceFlow),
    vscode.commands.registerCommand("claudeCodeTts.setupQwen3", setupQwen3Flow),
    vscode.commands.registerCommand("claudeCodeTts.setupChatterbox", setupChatterboxFlow),
    vscode.commands.registerCommand("claudeCodeTts.checkSetup", checkSetupFlow),
    vscode.commands.registerCommand("claudeCodeTts.downloadVoice", downloadVoiceFlow),
    vscode.commands.registerCommand("claudeCodeTts.selectRate", selectRate),
    vscode.commands.registerCommand("claudeCodeTts.languageVoice", setLanguageVoice),
    vscode.commands.registerCommand("claudeCodeTts.setupTranslation", setupTranslationFlow),
    // Internal (not in package.json): lets the voice-design flow offer the
    // download that maps the language rather than switching engines.
    vscode.commands.registerCommand("claudeCodeTts.downloadVoiceForLanguage", (code: string) =>
      downloadVoiceForLanguage(code)
    ),
    vscode.commands.registerCommand("claudeCodeTts.history", showHistory),
    vscode.commands.registerCommand("claudeCodeTts.menu", showMenu),
    vscode.commands.registerCommand("claudeCodeTts.resetSettings", resetSettings),
    vscode.commands.registerCommand("claudeCodeTts.removeEverything", () =>
      removeEverythingFlow({
        scanOptions,
        voicesDir: qwen3VoicesDir(runtime.context.globalStorageUri.fsPath),
        rebuildEngine,
      })
    ),
    vscode.commands.registerCommand("claudeCodeTts.configureSounds", configureSounds),
    vscode.commands.registerCommand("claudeCodeTts.cloneVoice", async () => {
      const value = await cloneVoiceFlow(runtime.context);
      if (!value) {
        return;
      }
      const engine = await activateVoiceProfile(value);
      if (!(await offerToSpeakProfileLanguage(value))) {
        vscode.window.showInformationMessage(
          engine === "chatterbox"
            ? "Claude Code TTS: voice cloned. Chatterbox will speak in it from the next sentence."
            : "Claude Code TTS: voice cloned. The model is switching now (~15s); the first sentence you hear will be your voice."
        );
        runtime.speech?.enqueue("Hello. This is your cloned voice speaking. Claude will sound like this from now on.");
        await offerReVoicedLanguage(value);
      }
    }),
    vscode.commands.registerCommand("claudeCodeTts.storage", (back?: boolean) =>
      storageFlow(storageDeps(), back === true)
    ),
    vscode.commands.registerCommand("claudeCodeTts.exportVoices", () => exportVoicesFlow(storageDeps())),
    vscode.commands.registerCommand("claudeCodeTts.importVoices", () => importVoicesFlow(storageDeps())),
    vscode.commands.registerCommand("claudeCodeTts.showLog", () => runtime.output.show()),
    vscode.commands.registerCommand("claudeCodeTts.manageVoices", (back?: boolean) =>
      manageVoicesFlow(
        {
          context: runtime.context,
          currentVoice: currentProfileVoice,
          fallbackVoice: () => {
            // Qwen3 can fall back to a preset; Chatterbox has none, so the next
            // profile is the only usable choice after deleting the one in use.
            if (vscode.workspace.getConfiguration("claudeCodeTts").get<string>("engine", "system") !== "chatterbox") {
              return "Ryan";
            }
            const rest = listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath));
            return rest.length ? `clone:${rest[0].slug}` : "default";
          },
          volume: () => config().speechConfig.volume,
          useVoice: async (value) => {
            if (!(await ensureVoiceEngine("Speaking in a voice you made"))) {
              return;
            }
            await activateVoiceProfile(value);
            if (await offerToSpeakProfileLanguage(value)) {
              return;
            }
            runtime.speech?.enqueue("This voice is active now.");
            await suggestQwen3For(profileFor(value)?.language ?? config().speechConfig.speakLanguage ?? "en");
          },
          refreshEngine: () => {
            // Profile data (gain, pace, reference) is read when the daemon
            // starts, so the engine has to be built again for a change to it
            // to be heard. Chatterbox speaks the same profiles, so it needs
            // this too; only the engines that do not use profiles are exempt.
            const active = config().speechConfig;
            if ((active.engine === "qwen3" || active.engine === "chatterbox") && isCloneVoice(active.voice)) {
              runtime.speech?.stop();
              runtime.speech?.rebuild();
              trackEngineReady();
            }
          },
        },
        back === true
      )
    ),
    vscode.commands.registerCommand("claudeCodeTts.designVoice", async () => {
      watchModelDownload(); // it fetches its own model, and that is a wait worth showing
      const value = await designVoiceFlow(runtime.context, config().speechConfig.volume, undefined, prepareTextFor);
      if (!value) {
        return;
      }
      await useNewProfile(
        value,
        "voice saved",
        "Hello. This is the voice you designed. Claude will sound like this from now on."
      );
    }),
    vscode.commands.registerCommand("claudeCodeTts.cloneVoiceFromFile", async () => {
      const value = await cloneFromFileFlow(runtime.context, config().speechConfig.volume);
      if (!value) {
        return;
      }
      await useNewProfile(
        value,
        "voice cloned from your recording",
        "Hello. This is the voice cloned from your recording. Claude will sound like this from now on."
      );
    }),
    vscode.commands.registerCommand("claudeCodeTts.toggleNotifications", async () => {
      const c = vscode.workspace.getConfiguration("claudeCodeTts");
      if (!c.get<boolean>("notifications.enabled", true)) {
        if (!(await installHooks(runtime.context, { ...config().notifications, enabled: true }))) {
          return;
        }
        await c.update("notifications.enabled", true, vscode.ConfigurationTarget.Global);
        syncNotifyRuntime(runtime.context, { ...config().notifications, enabled: true }, runtime.onError);
        demoSound(runtime.context);
        vscode.window.showInformationMessage(
          "Claude Code TTS: completion sounds enabled (that was the sound). If you also run the Claude Notifier extension, disable it to avoid duplicates."
        );
      } else {
        removeHooks(runtime.context);
        await c.update("notifications.enabled", false, vscode.ConfigurationTarget.Global);
        syncNotifyRuntime(runtime.context, { ...config().notifications, enabled: false }, runtime.onError);
        vscode.window.showInformationMessage("Claude Code TTS: completion sounds disabled and hooks removed.");
      }
    }),
    vscode.commands.registerCommand("claudeCodeTts.repeatLast", () => {
      if (lastSpoken().length === 0) {
        vscode.window.setStatusBarMessage("Claude Code TTS: nothing to repeat yet", 2000);
        return;
      }
      runtime.speech?.stop();
      // Through the speaking path, not straight into the queue: what was
      // recorded is the prose as Claude wrote it, so repeating it has to
      // translate and chunk it again, or it comes back in the language you
      // asked not to hear.
      for (const chunk of lastSpoken()) {
        speakLine(chunk);
      }
    }),
    // One command for "say this": the editor selection when there is one,
    // otherwise whatever the focused view will copy, otherwise the clipboard.
    // It shipped as two commands, and the weaker of them (clipboard only)
    // owned the shortcut, so the keystroke did less than the palette entry.
    vscode.commands.registerCommand("claudeCodeTts.speak", speakSelectionOrClipboard),
    // The original ids still work: a user's own keybinding must not break.
    vscode.commands.registerCommand("claudeCodeTts.speakSelection", speakSelectionOrClipboard),
    vscode.commands.registerCommand("claudeCodeTts.speakClipboard", async () => {
      const target = await clipboardTarget({ readClipboard: () => Promise.resolve(vscode.env.clipboard.readText()) });
      speakTarget(target, "The clipboard is empty. Select the text, copy it, then run this again.");
    }),
    vscode.commands.registerCommand("claudeCodeTts.languages", languagesMenu),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("claudeCodeTts")) {
        return;
      }
      runtime.speech?.setConfig(config().speechConfig);
      if (!config().enabled) {
        runtime.speech?.stop();
      }
      if (
        e.affectsConfiguration("claudeCodeTts.engine") ||
        e.affectsConfiguration("claudeCodeTts.qwen3") ||
        e.affectsConfiguration("claudeCodeTts.kokoro") ||
        e.affectsConfiguration("claudeCodeTts.piper")
      ) {
        trackEngineReady();
      }
      if (e.affectsConfiguration("claudeCodeTts.notifications")) {
        // A sound turned on or off changes which hooks are needed: an event
        // with no sound installs none, so Claude Code starts no process for it.
        if (config().notifications.enabled) {
          ensureHooksCurrent(runtime.context, config().notifications);
        }
        syncNotifyRuntime(runtime.context, config().notifications, runtime.onError);
      }
      updateStatus();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scopedDirs = workspaceProjectDirNames();
      runtime.ownership?.refresh();
    })
  );
}

export function deactivate(): void {
  // The subscriptions VSCode disposes cover the rest; these are the ones
  // holding a child process, a watcher or a file other windows read.
  runtime.control?.dispose();
  runtime.ownership?.dispose();
  runtime.tailer?.dispose();
  runtime.speech?.dispose();
  runtime.translator?.dispose();
  stopWatchingDownloads();
}
