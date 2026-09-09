/**
 * "Check Setup": one screen that says what works on THIS machine and what to
 * run to fix what does not. The point is that a Windows or Linux user never
 * has to translate macOS instructions: every fix below is the command for
 * the platform the code is running on.
 */

import * as fs from "fs";
import * as path from "path";
import { exe, hasCommand, isMac, isWindows, userScriptDirs } from "../platform/platform";

export type Status = "ok" | "partial" | "missing";

export interface Capability {
  name: string;
  status: Status;
  detail: string;
  /** What would fix it, in words, shown to the user. */
  fix?: string;
  /**
   * The command that performs the fix. Fixes used to be matched by parsing
   * their display text back into a command title, so a retitled command
   * silently became a fix button that did nothing; naming the command here
   * means the compiler keeps them together.
   */
  command?: string;
  /** Python package the extension can install itself, when that is the fix. */
  install?: string;
}

export interface DiagnosticsInput {
  /**
   * What is on the PATH, stated rather than looked up here. This function is
   * the report, so what it reports on is its input: probing inside it made
   * "everything is set up" untestable anywhere ffmpeg is absent, which is
   * every CI machine.
   */
  ffmpeg: boolean;
  ffplay: boolean;
  /** uv, pipx or a python, for the guided installs. */
  pythonInstaller: boolean;
  /** tar, which is what exports and imports a voice pack. */
  backups: boolean;
  engine: string;
  engineName: string;
  engineReady: boolean;
  kokoroReady: boolean;
  kokoroDaemon: boolean;
  qwen3Runtime: "mlx" | "torch" | undefined;
  /** Chatterbox runtime in use, and whether its text preparation is installed. */
  chatterboxRuntime: "mlx" | "torch" | undefined;
  chatterboxDiacritizer: boolean;
  /** Whether this window speaks sessions started outside it, and how many windows are open. */
  listenTo: string;
  terminalOwner: boolean;
  windows: number;
  piperAvailable: boolean;
  /** Persistent gapless player available (macOS today). */
  persistentPlayer: boolean;
  playerName: string;
  playerTempo: boolean;
  hooksInstalled: boolean;
  voices: number;
  /** Target speaking language ("" = speak each message as written). */
  speakLanguage: string;
  translationReady: boolean;
  /** Language pairs with a model installed, as "en>de". */
  translationPairs: string[];
}

const ffmpegInstall = (): string =>
  isMac ? "brew install ffmpeg" : isWindows ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg";

/** Python tool installer command for a package, matching what is installed. */
export function toolInstall(pkg: string): string {
  if (hasCommand("uv")) {
    return `uv tool install ${pkg}`;
  }
  if (hasCommand("pipx")) {
    return `pipx install ${pkg}`;
  }
  return `pip install --user ${pkg}`;
}

export function checkSetup(i: DiagnosticsInput): Capability[] {
  const out: Capability[] = [];
  const { ffmpeg, ffplay, pythonInstaller: uv } = i;

  out.push({
    name: `Speech engine: ${i.engineName}`,
    status: i.engineReady ? "ok" : "missing",
    detail: i.engineReady ? "ready to speak" : "selected but not usable yet",
    fix: i.engineReady
      ? undefined
      : i.engine === "kokoro"
        ? "set up Kokoro"
        : i.engine === "qwen3"
          ? "set up Qwen3"
          : i.engine === "chatterbox"
            ? "set up Chatterbox"
            : i.engine === "piper"
              ? toolInstall("piper-tts")
              : undefined,
    command: i.engineReady
      ? undefined
      : i.engine === "kokoro"
        ? "claudeCodeTts.setupKokoro"
        : i.engine === "qwen3"
          ? "claudeCodeTts.setupQwen3"
          : i.engine === "chatterbox"
            ? "claudeCodeTts.setupChatterbox"
            : undefined,
    install: !i.engineReady && i.engine === "piper" ? "piper-tts" : undefined,
  });

  out.push({
    name: "Playback",
    status: i.persistentPlayer ? "ok" : i.playerTempo ? "partial" : "missing",
    detail: i.persistentPlayer
      ? "streaming, gapless, live speed and volume"
      : i.playerTempo
        ? `${i.playerName}: speed and volume work, audio plays per sentence rather than streaming`
        : `${i.playerName}: plays audio, but cannot change speed or volume during playback`,
    fix: i.persistentPlayer || ffplay ? undefined : ffmpegInstall(),
  });

  out.push({
    name: "Speed control while speaking",
    status: i.playerTempo ? "ok" : "missing",
    detail: i.playerTempo
      ? "rate changes apply to the sentence being spoken"
      : "the rate is applied when synthesizing the next sentence",
    fix: i.playerTempo ? undefined : ffmpegInstall(),
  });

  out.push({
    name: "Clone a voice from the microphone",
    status: isMac || ffmpeg ? "ok" : "missing",
    detail: isMac ? "bundled recorder" : ffmpeg ? "records through ffmpeg" : "no recorder found",
    fix: isMac || ffmpeg ? undefined : ffmpegInstall(),
  });

  out.push({
    name: "Clone a voice from an audio or video file",
    status: isMac || ffmpeg ? "ok" : "partial",
    detail: isMac
      ? "every format the system can decode"
      : ffmpeg
        ? "every format ffmpeg can decode"
        : "only 24 kHz mono WAV files",
    fix: isMac || ffmpeg ? undefined : ffmpegInstall(),
  });

  out.push({
    name: "Voice cloning and design (Qwen3)",
    status: i.qwen3Runtime ? "ok" : "missing",
    detail: i.qwen3Runtime
      ? `${i.qwen3Runtime === "mlx" ? "MLX" : "PyTorch"} runtime, ${i.voices} voice${i.voices === 1 ? "" : "s"} saved`
      : uv
        ? "the Python package is not installed"
        : "not installed; the setup downloads its own Python tooling, nothing to install first",
    fix: i.qwen3Runtime ? undefined : "set up Qwen3",
    command: i.qwen3Runtime ? undefined : "claudeCodeTts.setupQwen3",
  });

  out.push({
    name: "Voice cloning in 23 languages (Chatterbox)",
    status: !i.chatterboxRuntime ? "missing" : i.voices === 0 ? "partial" : i.chatterboxDiacritizer ? "ok" : "partial",
    detail: !i.chatterboxRuntime
      ? "not installed; it speaks 23 languages in a voice you create"
      : i.voices === 0
        ? `${i.chatterboxRuntime === "mlx" ? "MLX" : "PyTorch"} runtime installed, but it has no voice to speak with yet`
        : i.chatterboxDiacritizer
          ? `${i.chatterboxRuntime === "mlx" ? "MLX" : "PyTorch"} runtime, ${i.voices} voice${i.voices === 1 ? "" : "s"} saved`
          : "installed, but the text preparation some languages need is missing",
    fix: !i.chatterboxRuntime
      ? "set up Chatterbox"
      : i.voices === 0
        ? "create a voice"
        : i.chatterboxDiacritizer
          ? undefined
          : "set up Chatterbox again",
    command: !i.chatterboxRuntime
      ? "claudeCodeTts.setupChatterbox"
      : i.voices === 0
        ? "claudeCodeTts.manageVoices"
        : i.chatterboxDiacritizer
          ? undefined
          : "claudeCodeTts.setupChatterbox",
  });

  out.push({
    name: "Kokoro streaming",
    status: !i.kokoroReady ? "missing" : i.kokoroDaemon ? "ok" : "partial",
    detail: !i.kokoroReady
      ? "Kokoro is not downloaded"
      : i.kokoroDaemon
        ? "streams sentence by sentence, first words in about half a second"
        : "synthesizes each sentence with the command-line tool (slower first word)",
    fix: !i.kokoroReady ? "set up Kokoro" : i.kokoroDaemon ? undefined : toolInstall("--with numpy sherpa-onnx"),
    command: !i.kokoroReady ? "claudeCodeTts.setupKokoro" : undefined,
    install: i.kokoroReady && !i.kokoroDaemon ? "--with numpy sherpa-onnx" : undefined,
  });

  if (i.speakLanguage) {
    const pair = `en>${i.speakLanguage}`;
    out.push({
      name: `Speaking everything in ${i.speakLanguage}`,
      status: !i.translationReady ? "missing" : i.translationPairs.includes(pair) ? "ok" : "partial",
      detail: !i.translationReady
        ? "the local translation engine is not installed"
        : i.translationPairs.includes(pair)
          ? `translating locally (${i.translationPairs.length} model${i.translationPairs.length === 1 ? "" : "s"} installed)`
          : `no model for ${pair}: messages in that direction are spoken as written`,
      fix: i.translationReady && i.translationPairs.includes(pair) ? undefined : "set up translation",
      command: i.translationReady && i.translationPairs.includes(pair) ? undefined : "claudeCodeTts.setupTranslation",
    });
  }

  out.push({
    name: "Sessions started in a terminal",
    status: i.listenTo === "workspace" ? "partial" : "ok",
    detail:
      i.listenTo === "workspace"
        ? "not spoken: this window is set to its own folders only"
        : i.terminalOwner
          ? i.windows > 1
            ? `spoken by this window (${i.windows} windows open; each speaks its own folders)`
            : "spoken by this window"
          : `spoken by another window (${i.windows} open), so you hear them once rather than ${i.windows} times`,
    fix: i.listenTo === "workspace" ? "speak every session on this machine" : undefined,
    command: i.listenTo === "workspace" ? "claudeCodeTts.menu" : undefined,
  });

  out.push({
    name: "Completion sounds",
    status: i.hooksInstalled ? "ok" : "partial",
    detail: i.hooksInstalled ? "Claude Code hooks installed" : "not enabled",
    fix: i.hooksInstalled ? undefined : "turn completion sounds on",
    command: i.hooksInstalled ? undefined : "claudeCodeTts.toggleNotifications",
  });

  out.push({
    name: "Voice backups",
    status: i.backups ? "ok" : "missing",
    detail: i.backups ? "export and import work" : "tar was not found on PATH",
    fix: i.backups ? undefined : isWindows ? "update to Windows 10 1803 or newer (it ships tar)" : "install tar",
  });

  if (isMac) {
    const tools = fs.existsSync("/Library/Developer/CommandLineTools") || fs.existsSync("/Applications/Xcode.app");
    out.push({
      name: "Bundled helpers (player, recorder, extractor)",
      status: tools ? "ok" : "partial",
      detail: tools ? "compiled from source on this machine" : "no Swift compiler: falling back to afplay and ffmpeg",
      fix: tools ? undefined : "xcode-select --install",
    });
  }

  // A piper install that exists but is not on PATH is a classic confusion.
  if (i.engine === "piper" && !i.piperAvailable) {
    const guess = userScriptDirs()
      .map((d) => path.join(d, exe("piper")))
      .find((p) => fs.existsSync(p));
    out.push({
      name: "Piper executable",
      status: "missing",
      detail: guess ? `found at ${guess} but not on PATH` : "not found",
      fix: guess ? `set claudeCodeTts.piper.path to ${guess}` : toolInstall("piper-tts"),
      install: guess ? undefined : "piper-tts",
    });
  }
  return out;
}

export function summarize(caps: Capability[]): string {
  const missing = caps.filter((c) => c.status === "missing").length;
  const partial = caps.filter((c) => c.status === "partial").length;
  if (missing === 0 && partial === 0) {
    return "Everything is set up";
  }
  if (missing === 0) {
    return `${partial} thing${partial === 1 ? "" : "s"} could be better`;
  }
  return `${missing} thing${missing === 1 ? "" : "s"} need attention`;
}
