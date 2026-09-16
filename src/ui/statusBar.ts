/**
 * What the status bar says, and the download it says it about.
 *
 * One line has to carry: whether anything is speaking, whether the engine is
 * still loading, how far a multi-gigabyte download has got, and the rate that
 * will actually be heard. The state behind it (is it speaking, is a model
 * loading, what is being fetched) lives here rather than in the flows,
 * because this module is the only thing that reads it.
 */
import * as vscode from "vscode";
import { config } from "../core/config";
import { languageName } from "../language/language";
import {
  combine,
  Download,
  expectedBytes,
  fetchExpectedBytes,
  fractionOf,
  hubDir,
  isFetching,
  Progress,
  progressText,
  scanHub,
} from "../platform/modelProgress";
import { runtime } from "../core/runtime";
import { isCloneVoice, listQwen3Clones, qwen3VoicesDir } from "../tts/qwen3";

/** The modifier the default keybindings use here; Windows and Linux differ. */
const CHORD = process.platform === "darwin" ? "ctrl+alt" : "ctrl+shift+alt";

/** True while an utterance is playing, for the menu's pause and skip rows. */
let speaking = false;
/** True while the active engine is still loading its model. */
let loadingModel = false;
/** Set while weights are being fetched, so the wait can say how long is left. */
let downloading: Progress | undefined;
let downloadTimer: NodeJS.Timeout | undefined;
/** Closes the generic download notification, while one is open. */
let closeNotice: (() => void) | undefined;
/** Flows showing the download in their own notification; the generic one stays away while any does. */
let claims = 0;

/** What is being fetched right now, added up, for a flow that shows the wait itself. */
export const downloadProgress = (): Progress | undefined => downloading;

/**
 * A flow about to report the download in its own notification takes this,
 * so the same bytes are not shown twice; the release it returns lets the
 * generic notification back for whatever is still fetching afterwards.
 */
export function claimDownloadNotice(): () => void {
  claims++;
  closeNotice?.();
  closeNotice = undefined;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      claims--;
    }
  };
}

/**
 * The model weights a runtime is fetching, shown inside a flow's own
 * notification: the message names what is being fetched with the bytes and
 * percentage, the bar follows, and `afterFetch` takes over once it is all
 * there. The generic notification stays away meanwhile. Returns what ends it.
 */
export function reportDownloadIn(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  words: { fetching: string; afterFetch: string }
): () => void {
  const release = claimDownloadNotice();
  let reported = 0;
  const tick = () => {
    const p = downloading;
    if (!p) {
      if (reported === 0) {
        progress.report({ message: `${words.fetching}...` });
      }
      return;
    }
    const done = fractionOf(p);
    const percent = done === undefined ? 0 : Math.round(done * 100);
    progress.report({
      message: done !== undefined && done >= 0.999 ? words.afterFetch : `${words.fetching}: ${progressText(p)}`,
      increment: Math.max(0, percent - reported),
    });
    reported = Math.max(reported, percent);
  };
  const ticker = setInterval(tick, 2000);
  tick();
  return () => {
    clearInterval(ticker);
    release();
  };
}

/** The speech queue reports what it is doing; the status bar shows it. */
export function noteSpeaking(isSpeaking: boolean): void {
  speaking = isSpeaking;
}

/** Whether the engine is still loading its model, for the setup report. */
export const isEngineLoading = (): boolean => loadingModel;

/** Whether anything is playing or queued, for the rows that act on it. */
export const isSpeaking = (): boolean => speaking || (runtime.speech?.pending ?? 0) > 0;

/** Stop the download watcher, at deactivation. */
export function stopWatchingDownloads(): void {
  if (downloadTimer) {
    clearInterval(downloadTimer);
  }
  downloadTimer = undefined;
}

export function updateStatus(): void {
  // Not created yet during activation
  if (!runtime.statusItem) {
    return;
  }
  const { enabled, speechConfig } = config();
  const pending = runtime.speech?.pending ?? 0;
  const suffix = pending > 1 ? ` (${pending})` : "";
  if (!enabled) {
    runtime.statusItem.text = "$(mute) Claude Code TTS";
    runtime.statusItem.tooltip = `Claude Code TTS: muted. ${CHORD}+v unmutes; click for menu.`;
  } else if (downloading) {
    runtime.statusItem.text = `$(cloud-download) Claude Code TTS ${progressText(downloading)}`;
    runtime.statusItem.tooltip =
      `Claude Code TTS: downloading ${downloading.count > 1 ? `${downloading.count} voice models` : "the voice model"}, ` +
      `${progressText(downloading)}. Fetched once, then it runs offline. Click for menu.`;
  } else if (loadingModel) {
    runtime.statusItem.text = "$(sync~spin) Claude Code TTS loading model";
    runtime.statusItem.tooltip = `Claude Code TTS: the ${runtime.speech?.engineName} engine is loading its model; runtime.speech starts when it is ready. Click for menu.`;
  } else if (runtime.speech?.isPaused) {
    runtime.statusItem.text = `$(debug-pause) Claude Code TTS${suffix}`;
    runtime.statusItem.tooltip = `Claude Code TTS: paused, backlog kept. ${CHORD}+p resumes; click for menu.`;
  } else if (speaking) {
    runtime.statusItem.text = `$(megaphone) Claude Code TTS${suffix}`;
    runtime.statusItem.tooltip = `Claude Code TTS: speaking. ${CHORD}+n skips, ${CHORD}+p pauses, ${CHORD}+v mutes; click for menu.`;
  } else {
    const audible = runtime.speech?.audibleRate() ?? speechConfig.rate;
    const capped = audible < speechConfig.rate - 5;
    // A rate the engine cannot reach is shown as what will be heard, in the
    // bar itself: a number in the settings that nothing obeys reads as a bug.
    runtime.statusItem.text = capped
      ? `$(unmute) Claude Code TTS ${audible} of ${speechConfig.rate} wpm`
      : "$(unmute) Claude Code TTS";
    runtime.statusItem.tooltip = capped
      ? `Claude Code TTS: you asked for ${speechConfig.rate} wpm, and ${runtime.speech?.engineName} synthesizes no faster than about ${audible} on this machine, so that is what you hear. ${fasterEngineHint()} Click for menu.`
      : `Claude Code TTS: listening at ${speechConfig.rate} wpm (engine: ${runtime.speech?.engineName}). Click for menu.`;
  }
}

/**
 * Watch the model cache while an engine warms up.
 *
 * The engines fetch their own weights inside the Python runtime, so there is
 * no response here to count bytes from; the cache directory growing is the
 * only evidence this side has. Without it the first use of a new engine is
 * several silent minutes under one spinner that says "loading model",
 * whether that means reading a file or pulling four gigabytes.
 */
export function watchModelDownload(): void {
  // One watcher, however many things start a fetch
  if (downloadTimer) {
    return;
  }
  const hub = hubDir();
  let previous = scanHub(hub);
  // Everything seen growing since this watcher started, so a second download
  // beginning does not replace the first: they are added together. Tracking
  // only what has grown here keeps an abandoned partial file from some other
  // tool out of the total.
  const tracked = new Map<string, Download>();
  /** Totals the hub was asked for, where the cache carries no listing. */
  const askedTotals = new Map<string, number | undefined>();
  let quiet = 0;
  let report: ((value: { message?: string; increment?: number }) => void) | undefined;
  let reported = 0;

  const stop = () => {
    if (downloadTimer) {
      clearInterval(downloadTimer);
    }
    downloadTimer = undefined;
    downloading = undefined;
    closeNotice?.();
    closeNotice = undefined;
    updateStatus();
  };

  const totalOf = (name: string): number | undefined => {
    const fromCache = expectedBytes(hub, name);
    if (fromCache !== undefined) {
      return fromCache;
    }
    if (!askedTotals.has(name)) {
      askedTotals.set(name, undefined);
      // A failed ask (offline) is asked again later; the module rate-limits it.
      void fetchExpectedBytes(name).then((total) =>
        total === undefined ? askedTotals.delete(name) : askedTotals.set(name, total)
      );
    }
    return askedTotals.get(name);
  };

  downloadTimer = setInterval(() => {
    const current = scanHub(hub);
    let grew = false;
    for (const [name, bytes] of current) {
      if (bytes > (previous.get(name) ?? 0)) {
        grew = true;
        tracked.set(name, { name, bytes, expected: totalOf(name) });
      } else if (tracked.has(name)) {
        tracked.set(name, { ...tracked.get(name)!, bytes, expected: totalOf(name) });
      }
    }
    previous = current;

    if (tracked.size > 0) {
      downloading = combine([...tracked.values()]);
      if (!closeNotice && claims === 0) {
        // Only once something is really arriving: a model already on disk
        // loads in seconds and deserves no notification at all. A flow that
        // shows the wait in its own notification keeps this one away.
        const shown = new Promise<void>((resolve) => (closeNotice = resolve));
        reported = 0;
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Claude Code TTS: downloading voice models" },
          (progress) => {
            report = (value) => progress.report(value);
            return shown;
          }
        );
      }
      const done = fractionOf(downloading);
      const percent = done === undefined ? 0 : Math.round(done * 100);
      report?.({ message: progressText(downloading), increment: Math.max(0, percent - reported) });
      reported = Math.max(reported, percent);
      updateStatus();
    }

    // A transfer can be quiet for a while (a large file being verified, a
    // throttled connection), so partial files keep the watch alive; it ends
    // only when nothing has moved and nothing is half-written.
    quiet = grew ? 0 : quiet + 1;
    const busy = [...tracked.keys()].some((name) => isFetching(hub, name));
    if (!grew && !busy && quiet > 30) {
      stop();
    }
  }, 2000);
  downloadTimer.unref?.();
}

/** Reflect engine readiness in the status bar (neural daemons take seconds). */
export function trackEngineReady(): void {
  const s = runtime.speech;
  if (!s) {
    return;
  }
  loadingModel = true;
  watchModelDownload();
  updateStatus();
  const settle = () => {
    // Superseded
    if (runtime.speech !== s) {
      return;
    }
    loadingModel = false;
    updateStatus();
  };
  s.ready.then(settle, settle);
}

/** Where to go for speed, when the engine in use has none left to give. */
export function fasterEngineHint(): string {
  const { engine, qwen3Model } = config().speechConfig;
  if (engine === "qwen3" && qwen3Model === "1.7B") {
    return "The smaller Qwen3 model is faster (Voice and speed, Voice model); Kokoro and the system voice speak at any rate.";
  }
  if (engine === "qwen3" || engine === "chatterbox") {
    return "Kokoro and the system voice speak at any rate (Voice and speed, Choose voice engine).";
  }
  return "";
}

/** What the status bar's tooltip and the menu's header say about right now. */
export function currentStateLine(): string {
  const { enabled, speechConfig } = config();
  if (!enabled) {
    return "muted";
  }
  const engine = runtime.speech?.engineName ?? speechConfig.engine;
  const voice = speechConfig.voice ? `, ${voiceLabel(speechConfig.voice)}` : "";
  const language = speechConfig.speakLanguage ? `, everything in ${languageName(speechConfig.speakLanguage)}` : "";
  return `${engine}${voice}${language}, ${speechConfig.rate} wpm`;
}

/** A voice value as a person would say it ("clone:my-voice" is a slug). */
export function voiceLabel(value: string): string {
  if (!isCloneVoice(value)) {
    return value;
  }
  const slug = value.slice("clone:".length);
  const profile = listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath)).find((p) => p.slug === slug);
  return profile?.name ?? slug;
}
