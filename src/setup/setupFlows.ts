/**
 * Installing the things this extension speaks with.
 *
 * Every engine here is a download and a consent: a Python tool, a
 * virtualenv, weights measured in gigabytes. The flows that ask for that
 * consent, run the install with a progress bar, and repair an install that
 * is missing a piece all live here, away from the flows that merely use the
 * result. Nothing here shows a voice list: that is the picker's job, reached
 * through a command so this module needs to know nothing about it.
 */
import * as vscode from "vscode";
import { checkSetup, summarize } from "./diagnostics";
import { config } from "../core/config";
import { languageName } from "../language/language";
import { recommendEngine, recommendedSettings, shouldWriteDefault, thisMachine, wantedLanguages } from "./onboarding";
import { hooksInstalled } from "./notifySetup";
import { downloadPiperVoice } from "./piperSetup";
import { kokoroDirOf, setupKokoro } from "./kokoroSetup";
import { runtime } from "../core/runtime";
import { isEngineLoading, trackEngineReady } from "../ui/statusBar";
import { setupQwen3 } from "./qwen3Setup";
import { findKokoroPython, kokoroReady } from "../tts/kokoro";
import { piperAvailable } from "../tts/piper";
import {
  CHATTERBOX_TEXT_PACKAGES,
  chatterboxReady,
  chatterboxRuntimePython,
  chatterboxVenv,
  DIACRITIZED_LANGUAGES,
  diacritizerReady,
  missingTextPackages,
  resolveChatterboxRuntime,
} from "../tts/chatterbox";
import { listQwen3Clones, qwen3Available, qwen3VoicesDir, resolveQwen3Runtime } from "../tts/qwen3";
import { audioSupport } from "../tts/wavPlayers";
import { getPersistentPlayer } from "../tts/audio";
import { MenuOutcome, pickWithBack } from "../ui/prompts";
import { findUv, installPrivateUv, runUv, toolInstallArgs, UV_VERSION, UvInfo } from "../platform/uvBootstrap";
import { hasCommand, venvPython } from "../platform/platform";

/** Where a person is sent to install the Piper program themselves. */
const PIPER_INSTALL_URL = "https://github.com/OHF-Voice/piper1-gpl";
import { translationAvailable } from "../language/translate";

/** Set once a better voice has been offered, so it is offered once ever. */
const NUDGED_KEY = "claudeCodeTts.offeredBetterVoice";

/** The languages this user listens to, as the recommendation reads them. */
export function listeningLanguages(): string[] {
  const cfg = config().speechConfig;
  return wantedLanguages({
    speakLanguage: cfg.speakLanguage,
    languageVoices: cfg.languageVoices,
    displayLanguage: vscode.env.language,
  });
}

/** What this user should be running, given their languages and their hardware. */
export const currentRecommendation = () => recommendEngine(listeningLanguages(), thisMachine());

/**
 * Some defaults are a property of the machine, not a preference: which
 * checkpoint is worth its download here, and how long a multi-gigabyte model
 * should sit in memory doing nothing. Applied when the user first sets up an
 * engine, never over a value they set themselves, and never written at all
 * when it matches what the extension ships with.
 */
export async function applyMachineDefaults(): Promise<void> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  for (const [key, value] of Object.entries(recommendedSettings(thisMachine()))) {
    if (!shouldWriteDefault(c.inspect(key), value)) {
      continue;
    }
    await c.update(key, value, vscode.ConfigurationTarget.Global);
    runtime.output.appendLine(`[setup] ${key} = ${String(value)} (chosen for this machine)`);
  }
}

/**
 * One way in, from the greeting, the status bar, the walkthrough and the
 * palette. It decides which engine this user should have rather than showing
 * a comparison table, installs it with the flow that already knows how, and
 * ends where the point of it is: a voice of their own.
 */
export async function setupBestVoiceFlow(): Promise<void> {
  const recommended = currentRecommendation();
  const ready =
    recommended.engine === "qwen3"
      ? qwen3Available()
      : recommended.engine === "chatterbox"
        ? chatterboxReady(runtime.context.globalStorageUri.fsPath)
        : kokoroReady(kokoroDirOf(runtime.context));
  if (ready && config().speechConfig.engine === recommended.engine) {
    // Nothing left to install. The two engines that can speak as a voice of
    // your own go to that; the light one has fixed voices, so it goes to the
    // list of them.
    if (recommended.engine === "kokoro") {
      await vscode.commands.executeCommand("claudeCodeTts.selectVoice");
    } else {
      await offerVoiceCreation();
    }
    return;
  }
  // The machine's own defaults are written once the user has agreed to the
  // install, never before it: a cancelled setup must leave nothing behind.
  if (recommended.engine === "chatterbox") {
    if (await setupChatterboxFlow()) {
      await applyMachineDefaults();
    }
  } else if (recommended.engine === "kokoro") {
    await setupKokoroFlow(); // nothing here is tuned by machine: one small model, always loaded
  } else {
    await setupQwen3Flow(); // applies them itself, before the first download
  }
}

/**
 * The reason these engines are worth installing: they speak as a voice you
 * recorded or described, not as one of a fixed set.
 */
export async function offerVoiceCreation(): Promise<void> {
  const profiles = listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath));
  const pick = await vscode.window.showInformationMessage(
    profiles.length > 0
      ? "Claude Code TTS: this engine speaks as any voice you have made. Choose one, or make another."
      : "Claude Code TTS: this engine can speak in a voice of your own. Describe the voice you want, or record ten seconds of yours.",
    ...(profiles.length > 0 ? ["Choose a voice", "Design a voice"] : ["Design a voice", "Record my voice"])
  );
  if (pick === "Choose a voice") {
    await vscode.commands.executeCommand("claudeCodeTts.selectVoice");
  } else if (pick === "Design a voice") {
    await vscode.commands.executeCommand("claudeCodeTts.designVoice");
  } else if (pick === "Record my voice") {
    await vscode.commands.executeCommand("claudeCodeTts.cloneVoice");
  }
}

/** Once in the life of an installation, and only while it is still worth it. */
export async function offerBetterVoice(): Promise<void> {
  await runtime.context.globalState.update(NUDGED_KEY, true); // asked, whatever the answer
  const recommended = currentRecommendation();
  const pick = await vscode.window.showInformationMessage(
    `Claude Code TTS is reading everything in the voice this computer came with. ${recommended.reason} One guided install, and it runs offline afterwards.`,
    "Set up the best voice",
    "Keep this one"
  );
  if (pick === "Set up the best voice") {
    await setupBestVoiceFlow();
  }
}

/** Piper's executable is a Python package; install it in place. True when it is usable afterwards. */
export async function ensurePiper(): Promise<boolean> {
  if (piperAvailable(config().speechConfig.piperPath)) {
    return true;
  }
  const pick = await vscode.window.showInformationMessage(
    "Piper is not installed (or claudeCodeTts.piper.path points elsewhere). Install it now? It is a small Python package, installed into Claude Code TTS's own runtime.",
    { modal: true },
    "Install Piper",
    "Open install instructions"
  );
  if (pick === "Open install instructions") {
    vscode.env.openExternal(vscode.Uri.parse(PIPER_INSTALL_URL));
  }
  if (pick !== "Install Piper") {
    return false;
  }
  if (!(await installTool("piper-tts", "Piper"))) {
    return false;
  }
  return piperAvailable(config().speechConfig.piperPath);
}

export async function downloadVoiceFlow(): Promise<void> {
  // The engine only switches once it can actually speak: a download that
  // then landed on an engine without its executable was a mute engine.
  if (!(await ensurePiper())) {
    return;
  }
  const modelPath = await downloadPiperVoice(runtime.context);
  if (!modelPath) {
    return;
  }
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  await c.update("piper.voice", modelPath, vscode.ConfigurationTarget.Global);
  await c.update("engine", "piper", vscode.ConfigurationTarget.Global);
  runtime.speech?.enqueue("This is your new Piper voice. Claude will sound like this from now on.");
}

/**
 * "Check Setup": what works here, and the command that fixes what does not,
 * written for the platform the user is actually on.
 */
export async function checkSetupFlow(back = false): Promise<MenuOutcome> {
  const cfg = config().speechConfig;
  const audio = audioSupport();
  const caps = checkSetup({
    ffmpeg: hasCommand("ffmpeg"),
    ffplay: hasCommand("ffplay"),
    pythonInstaller: hasCommand("uv") || hasCommand("pipx") || hasCommand("python3") || hasCommand("python"),
    backups: hasCommand("tar"),
    engine: cfg.engine,
    engineName: runtime.speech?.engineName ?? cfg.engine,
    engineReady: !isEngineLoading() && (runtime.speech?.hasEngine ?? false),
    kokoroReady: kokoroReady(kokoroDirOf(runtime.context)),
    kokoroDaemon: findKokoroPython() !== undefined,
    qwen3Runtime: resolveQwen3Runtime(cfg.qwen3Runtime),
    chatterboxRuntime: resolveChatterboxRuntime(runtime.context.globalStorageUri.fsPath, cfg.chatterboxRuntime),
    chatterboxDiacritizer: diacritizerReady(runtime.context.globalStorageUri.fsPath, cfg.chatterboxRuntime),
    listenTo: config().listenTo,
    terminalOwner: runtime.ownership?.isTerminalOwner() ?? true,
    windows: runtime.ownership?.windowCount() ?? 1,
    piperAvailable: piperAvailable(cfg.piperPath),
    persistentPlayer: getPersistentPlayer() !== undefined,
    playerName: audio.player,
    playerTempo: audio.tempo,
    hooksInstalled: hooksInstalled(runtime.context),
    voices: listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath)).length,
    speakLanguage: cfg.speakLanguage,
    translationReady: translationAvailable(),
    translationPairs: cfg.speakLanguage && runtime.translator?.available ? await runtime.translator.pairs() : [],
  });
  const icon = { ok: "$(check)", partial: "$(warning)", missing: "$(error)" };
  const picked = await pickWithBack(
    caps.map((c) => ({
      label: `${icon[c.status]} ${c.name}`,
      description: c.fix ? "fix available" : "",
      detail: c.fix ? `${c.detail} - ${c.fix}` : c.detail,
      cap: c,
    })),
    {
      placeHolder: "Select an item to copy or run its fix",
      title: `Setup on ${process.platform}: ${summarize(caps)}`,
      matchOnDetail: true,
    },
    back
  );
  if (picked === "back") {
    return "back";
  }
  const cap = picked?.cap;
  if (!cap) {
    return "closed";
  }
  // The extension does the fix itself whenever it can: a command it owns, or
  // a Python package it can install through its own uv. Only a fix that needs
  // the user's own shell (a package manager, xcode-select) is handed over as
  // text, and then it goes to the clipboard rather than into a dead end.
  if (cap.command) {
    await vscode.commands.executeCommand(cap.command);
    return "ran";
  }
  if (cap.install) {
    const parts = cap.install.split(" ");
    const pkg = parts.pop()!;
    await installTool(pkg, cap.name, parts);
    return "ran";
  }
  if (!cap.fix) {
    return "ran";
  }
  await vscode.env.clipboard.writeText(cap.fix);
  vscode.window.showInformationMessage(`Claude Code TTS: copied to the clipboard - ${cap.fix}`);
  return "ran";
}

/**
 * The uv that installs Python engines: the user's own when they have one,
 * otherwise the extension's private copy, downloaded with consent, verified
 * against its published SHA-256 and kept inside globalStorage together with
 * everything it installs. Returns undefined when the user declined or the
 * download failed (already reported).
 */
export async function ensureUvWithConsent(purpose: string): Promise<UvInfo | undefined> {
  const storage = runtime.context.globalStorageUri.fsPath;
  const existing = findUv(storage);
  if (existing) {
    return existing;
  }
  const go = await vscode.window.showInformationMessage(
    `${purpose} is a Python package. Claude Code TTS can install it without you running anything: it downloads its own copy of the uv tool (version ${UV_VERSION}, about 15 MB, verified against the checksum the uv project publishes) into its storage folder and installs the package and a Python there. Nothing outside that folder is touched, and "Storage and Cleanup" removes it all in one step.`,
    { modal: true },
    "Download uv and continue"
  );
  if (go !== "Download uv and continue") {
    return undefined;
  }
  const ok = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Claude Code TTS: preparing the Python runtime",
      cancellable: false,
    },
    async (progress) => {
      let got = 0;
      try {
        await installPrivateUv(storage, (message, bytes) => {
          if (bytes) {
            got += bytes;
          }
          progress.report({ message: bytes ? `${message} (${Math.round(got / 1024 / 1024)} MB)` : message });
        });
        runtime.output.appendLine(`[setup] uv ${UV_VERSION} installed privately under ${storage}`);
        return true;
      } catch (e) {
        runtime.output.appendLine(`[setup] uv download failed: ${(e as Error).message}`);
        return false;
      }
    }
  );
  if (!ok) {
    vscode.window
      .showErrorMessage(
        "Claude Code TTS: could not download the uv tool (see the log). Nothing was installed.",
        "Show log"
      )
      .then((p) => p && runtime.output.show());
    return undefined;
  }
  return findUv(storage);
}

/** Install a Python tool through uv with progress and a log; false when it did not succeed. */
export async function installTool(pkg: string, purpose: string, extra: string[] = []): Promise<boolean> {
  const uv = await ensureUvWithConsent(purpose);
  if (!uv) {
    return false;
  }
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Claude Code TTS: installing ${pkg} (a few minutes)`,
      cancellable: true,
    },
    async (progress, token) => {
      const result = await runUv(
        uv,
        toolInstallArgs(uv, pkg, extra),
        (line) => {
          runtime.output.appendLine(`[install] ${line}`);
          progress.report({ message: line.slice(0, 60) });
        },
        { onCancel: (kill) => token.onCancellationRequested(kill) }
      );
      if (!result.ok && result.error !== "cancelled") {
        vscode.window
          .showErrorMessage(`Claude Code TTS: installing ${pkg} did not succeed (${result.error}).`, "Show log")
          .then((p) => p && runtime.output.show());
      }
      return result.ok;
    }
  );
}

/**
 * Chatterbox on MLX has no built-in speaker: the v3 checkpoint ships no
 * conditionals, so it can only speak in a cloned or designed voice. Installing
 * it without one is a dead end, so route straight to making or picking a voice.
 */
export async function offerChatterboxVoice(): Promise<void> {
  const clones = listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath));
  const current = config().speechConfig.chatterboxVoice;
  if (clones.some((c) => `clone:${c.slug}` === current)) {
    vscode.window.showInformationMessage(
      "Claude Code TTS: Chatterbox is set up. The first sentence downloads its weights (~3 GB), then it speaks in your voice."
    );
    return;
  }
  const next = await vscode.window.showInformationMessage(
    clones.length
      ? "Claude Code TTS: Chatterbox is set up. It has no built-in voice, so choose one of yours to speak with."
      : "Claude Code TTS: Chatterbox is set up. It has no built-in voice: it only speaks as a voice you create.",
    ...(clones.length ? ["Choose a voice"] : ["Design a voice", "Clone my voice"])
  );
  if (next === "Choose a voice") {
    await vscode.commands.executeCommand("claudeCodeTts.selectVoice");
  } else if (next === "Design a voice") {
    await vscode.commands.executeCommand("claudeCodeTts.designVoice");
  } else if (next === "Clone my voice") {
    await vscode.commands.executeCommand("claudeCodeTts.cloneVoice");
  }
}

/**
 * Called before a voice is recorded in a language, by the flow that records
 * it. A reference recorded from guessed vowels is mispronounced speech
 * stored as the voice itself, so this is the last moment it can be fixed.
 */
export async function prepareTextFor(code: string): Promise<void> {
  if (DIACRITIZED_LANGUAGES.includes(code)) {
    await ensureChatterboxText(languageName(code));
  }
}

/**
 * Add the text preparation to a runtime that is already installed.
 *
 * Being installed and being able to read a writing system are different
 * facts here: on Apple Silicon the engine runs inside the mlx-audio tool the
 * Qwen3 setup also installs, so someone who set Qwen3 up first and then
 * designed a voice never passed through the Chatterbox setup, and every
 * sentence in a language whose vowels are not written came out as other
 * words with nothing said about it. This is the repair, offered wherever
 * that language is about to be spoken.
 *
 * Installed into the runtime rather than through `uv tool install --with`,
 * which would rebuild the tool and could move mlx-audio to a version the
 * engines have not been measured on.
 */
export async function ensureChatterboxText(subject?: string, asked = false): Promise<boolean> {
  const storage = runtime.context.globalStorageUri.fsPath;
  const pref = config().speechConfig.chatterboxRuntime;
  const missing = missingTextPackages(storage, pref);
  if (missing.length === 0) {
    return true;
  }
  const python = chatterboxRuntimePython(storage, pref);
  if (!python) {
    return false;
  }
  const ADD = "Add it";
  const go = asked
    ? ADD
    : await vscode.window.showInformationMessage(
        subject
          ? `Claude Code TTS: ${subject} is written without vowel marks. The model guesses them and says other words, so it needs the package that restores them first: about 50 MB from PyPI, once.`
          : "Claude Code TTS: Chatterbox is installed, but the text preparation some writing systems need is not. Without it those languages are spoken from guessed vowels. About 50 MB from PyPI, once.",
        { modal: true },
        ADD
      );
  if (go !== ADD) {
    return false;
  }
  const uv = await ensureUvWithConsent("Chatterbox");
  if (!uv) {
    return false;
  }
  const ok = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Claude Code TTS: adding text preparation",
      cancellable: true,
    },
    async (_progress, token) => {
      const r = await runUv(
        uv,
        ["pip", "install", "--python", python, ...missing],
        (line) => runtime.output.appendLine(`[chatterbox text] ${line}`),
        {
          onCancel: (kill) => token.onCancellationRequested(kill),
        }
      );
      return r.ok;
    }
  );
  if (!ok || missingTextPackages(storage, pref).length > 0) {
    vscode.window
      .showErrorMessage("Claude Code TTS: the text preparation did not install (see the log).", "Show log")
      .then((pick) => pick && runtime.output.show());
    return false;
  }
  return true;
}

/**
 * The install itself, without deciding anything about the engine setting.
 * `ask` is false when the caller has already asked (the flow that sets up a
 * voice, its language and its engine in one confirmation): a second modal
 * for the same yes is exactly the friction that made people give up halfway
 * through and end up with a voice that never spoke.
 */
export async function installChatterboxRuntime(ask: boolean): Promise<boolean> {
  const storage = runtime.context.globalStorageUri.fsPath;
  if (resolveChatterboxRuntime(storage)) {
    return true;
  }
  // Apple Silicon: mlx-audio carries the Chatterbox port, so there is no
  // virtualenv to build and it runs the v3 weights the PyPI package cannot
  // load. Same tool the Qwen3 engine uses, so this is often already done.
  if (process.platform === "darwin" && process.arch === "arm64") {
    if (ask) {
      const go = await vscode.window.showInformationMessage(
        "Set up Chatterbox (Resemble AI, MIT)? It clones your voice and speaks 23 languages, a dozen of which no other engine here covers. " +
          "On this Mac it runs on MLX: about 1.45x slower than realtime, roughly 1.7x faster than the PyTorch path, so it speaks calmly to stay in sync. It installs the mlx-audio tool and downloads ~3 GB of weights on first use.",
        { modal: true },
        "Install"
      );
      if (go !== "Install") {
        return false;
      }
    }
    const done = await installTool(
      "mlx-audio@latest",
      "Chatterbox",
      CHATTERBOX_TEXT_PACKAGES.flatMap((p) => ["--with", p.spec])
    );
    if (!done || !chatterboxReady(storage)) {
      vscode.window
        .showErrorMessage("Claude Code TTS: installing mlx-audio did not succeed.", "Show log")
        .then((pick) => pick && runtime.output.show());
      return false;
    }
    return true;
  }
  if (ask) {
    const consent = await vscode.window.showInformationMessage(
      "Set up Chatterbox (Resemble AI, MIT)? It clones your voice and speaks 23 languages, a dozen of which no other engine here covers. " +
        "It installs an isolated Python environment (~1 GB) and downloads ~2.5 GB of weights on first use, and it is slow: about 2.4x slower than realtime, so it lags behind long runtime.output. " +
        "This runtime loads the older v2 weights (the published package cannot load v3); most of the non-Latin languages were verified on the MLX runtime rather than this one.",
      { modal: true },
      "Install"
    );
    if (consent !== "Install") {
      return false;
    }
  }
  const uv = await ensureUvWithConsent("Chatterbox");
  if (!uv) {
    return false;
  }
  const venv = chatterboxVenv(storage);
  const ok = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Claude Code TTS: installing Chatterbox (several minutes)",
      cancellable: true,
    },
    async (progress, token) => {
      const steps: [string, string[]][] = [
        ["creating the environment", ["venv", venv, "--python", "3.12"]],
        // Pinned: an unpinned install would silently pull a future release
        // into the user's environment. setuptools stays bounded rather than
        // pinned because its watermarker only needs pkg_resources to exist.
        [
          "downloading packages",
          [
            "pip",
            "install",
            "--python",
            venvPython(venv),
            "chatterbox-tts==0.1.7",
            "setuptools<81",
            ...CHATTERBOX_TEXT_PACKAGES.map((p) => p.spec),
          ],
        ],
      ];
      for (const [message, args] of steps) {
        progress.report({ message });
        const r = await runUv(uv, args, (line) => runtime.output.appendLine(`[chatterbox] ${line}`), {
          onCancel: (kill) => token.onCancellationRequested(kill),
        });
        if (!r.ok) {
          return false;
        }
      }
      return true;
    }
  );
  if (!ok || !chatterboxReady(storage)) {
    vscode.window
      .showErrorMessage("Claude Code TTS: installing Chatterbox did not succeed.", "Show log")
      .then((p) => p && runtime.output.show());
    return false;
  }
  return true;
}

/**
 * Set up Chatterbox. On Apple Silicon this is just `uv tool install
 * mlx-audio` (usually already there for Qwen3): that runtime is about 1.7x
 * faster here and runs the newer v3 weights. Everywhere else it needs its own
 * virtualenv, because it pins torch 2.6 and needs setuptools older than 81
 * (its watermarker imports pkg_resources, which newer setuptools dropped).
 */
export async function setupChatterboxFlow(): Promise<boolean> {
  const storage = runtime.context.globalStorageUri.fsPath;
  const installed = resolveChatterboxRuntime(storage);
  if (installed) {
    const speed =
      installed === "mlx"
        ? "It runs on MLX here, about 1.45x slower than realtime, so it speaks calmly to stay in sync."
        : "It runs on PyTorch here, about 2.4x slower than realtime, so it lags behind long runtime.output.";
    const go = await vscode.window.showInformationMessage(
      `Claude Code TTS: Chatterbox is installed. Switch to it? It clones your voice in 23 languages. ${speed}`,
      { modal: true },
      "Use Chatterbox"
    );
    if (go !== "Use Chatterbox") {
      return false;
    }
    // Installed by the Qwen3 setup, most likely, which does not carry these.
    await ensureChatterboxText();
    await vscode.workspace
      .getConfiguration("claudeCodeTts")
      .update("engine", "chatterbox", vscode.ConfigurationTarget.Global);
    trackEngineReady();
    await offerChatterboxVoice();
    return true;
  }
  if (!(await installChatterboxRuntime(true))) {
    return false;
  }
  await vscode.workspace
    .getConfiguration("claudeCodeTts")
    .update("engine", "chatterbox", vscode.ConfigurationTarget.Global);
  trackEngineReady();
  if (resolveChatterboxRuntime(storage) === "mlx") {
    await offerChatterboxVoice();
  } else {
    vscode.window.showInformationMessage(
      'Claude Code TTS: Chatterbox is set up. The first sentence downloads its weights (~2.5 GB), then it speaks. Pick one of your cloned voices in "Select Voice".'
    );
  }
  return true;
}

/**
 * The checkpoint this install will use: the one the user chose if they chose
 * one, otherwise the one this machine can carry.
 */
export function plannedQwen3Model(): string {
  const set = vscode.workspace.getConfiguration("claudeCodeTts").inspect<string>("qwen3.model");
  return set?.workspaceValue ?? set?.globalValue ?? recommendedSettings(thisMachine())["qwen3.model"];
}

/** What that checkpoint costs to download, for the messages that ask first. */
export function qwen3ModelDownload(): string {
  return plannedQwen3Model() === "1.7B" ? "~4.2 GB, the larger and more natural model this machine can run" : "~2.3 GB";
}

/**
 * The runtime the voice designer and the refiner run on, installed here if it
 * is missing.
 *
 * Both used to check for it and then print the uv command for the user to run
 * themselves, which is a dead end inside a flow they had already started: the
 * extension can install it, and everywhere else in this extension does.
 */
export async function ensureQwen3Runtime(what: string): Promise<boolean> {
  if (resolveQwen3Runtime(config().speechConfig.qwen3Runtime)) {
    return true;
  }
  const SET_UP = "Set up Qwen3";
  const pick = await vscode.window.showInformationMessage(
    `Claude Code TTS: ${what} runs on Qwen3-TTS, which is not installed here yet. Set it up? It installs a Python tool and downloads the model on first use (${qwen3ModelDownload()}, once), then it works offline.`,
    { modal: true },
    SET_UP
  );
  if (pick !== SET_UP) {
    return false;
  }
  await setupQwen3Flow();
  return resolveQwen3Runtime(config().speechConfig.qwen3Runtime) !== undefined;
}

/**
 * An engine that can speak a voice of your own, installed here if there is
 * none.
 *
 * A profile is a reference recording; only Qwen3 and Chatterbox can speak
 * one. Recording or importing one with neither installed produced a file on
 * disk and a voice nobody could hear, which is the worst kind of success.
 */
export async function ensureVoiceEngine(what: string): Promise<boolean> {
  if (chatterboxReady(runtime.storagePath)) {
    return true;
  }
  return ensureQwen3Runtime(what);
}

/** Install Qwen3 if needed, switch to it, and warm the model. */
export async function setupQwen3Flow(): Promise<boolean> {
  return setupQwen3({
    log: (line) => runtime.output.appendLine(`[qwen3 setup] ${line}`),
    showLog: () => runtime.output.show(),
    installTool: (pkg) => installTool(pkg, "Qwen3"),
    modelDownload: qwen3ModelDownload(),
    activate: async () => {
      await applyMachineDefaults(); // before the engine switch: it decides which weights download
      const c = vscode.workspace.getConfiguration("claudeCodeTts");
      await c.update("engine", "qwen3", vscode.ConfigurationTarget.Global);
      trackEngineReady();
      const next = await vscode.window.showInformationMessage(
        `Claude Code TTS: Qwen3 is active. The model downloads on first use (${qwen3ModelDownload()}, once). Meanwhile you can create a voice of your own.`,
        "Design a voice",
        "Clone my voice",
        "Just speak"
      );
      if (next === "Design a voice") {
        await vscode.commands.executeCommand("claudeCodeTts.designVoice");
      } else if (next === "Clone my voice") {
        await vscode.commands.executeCommand("claudeCodeTts.cloneVoice");
      } else {
        runtime.speech?.enqueue("Qwen3 is ready. Claude will sound like this from now on.");
      }
    },
  });
}

export async function setupKokoroFlow(): Promise<void> {
  if (!(await setupKokoro(runtime.context))) {
    return;
  }
  await vscode.workspace
    .getConfiguration("claudeCodeTts")
    .update("engine", "kokoro", vscode.ConfigurationTarget.Global);
  runtime.speech?.enqueue("Kokoro is ready. Claude will sound like this from now on.");
}
