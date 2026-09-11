/**
 * "Export Spoken Audio to a File": the last message, or any part of what was
 * played recently, written as an MP3 or another format the way it was heard.
 *
 * The choices are a sheet rather than a wizard. Its first row exports with
 * what is set, and the defaults are the ones worth having: a good MP3 of the
 * whole selection, at the speed it played, with the pauses between sentences
 * kept short. Every other row changes one thing and comes back to the sheet,
 * and the size the file will be is recomputed as the choices change, so a
 * quality is chosen by what it costs rather than by its name. The last
 * choices are remembered for the next export.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { config } from "../core/config";
import { runtime } from "../core/runtime";
import { isMac, isWindows } from "../platform/platform";
import { playSample } from "../voices/design";
import {
  BACK,
  inputWithBack,
  MenuOutcome,
  MenuRow,
  offerCommand,
  pickManyWithBack,
  pickWithBack,
  pickWithPreview,
  runMenu,
  separator,
} from "../ui/prompts";
import {
  canStretch,
  clock,
  Encoders,
  estimateBytes,
  exportAudio,
  ExportFormat,
  ExportQuality,
  findEncoders,
  firstWords,
  formatForPath,
  FORMATS,
  messagesOf,
  missingFor,
  parseRange,
  PAUSE_CAP,
  PauseStyle,
  PlayedMessage,
  QUALITY_LABEL,
  sampleRateOf,
  Segment,
  sizeLabel,
  SpeedChoice,
  timeline,
  totalSeconds,
} from "./audioExport";
import { heardSeconds, PlayedEntry, playedAudio } from "./playedAudio";

const OPTIONS_KEY = "claudeCodeTts.export.options";
const DIR_KEY = "claudeCodeTts.export.dir";

interface Options {
  format: ExportFormat;
  quality: ExportQuality;
  speed: SpeedChoice;
  pauses: PauseStyle;
}

const DEFAULTS: Options = { format: "mp3", quality: "good", speed: "asPlayed", pauses: "natural" };

const heardTotal = (entries: PlayedEntry[]): number => entries.reduce((n, e) => n + heardSeconds(e), 0);

const timeOfDay = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const sentences = (n: number): string => `${n} sentence${n === 1 ? "" : "s"}`;

const ffmpegInstall = (): string =>
  isMac ? "brew install ffmpeg" : isWindows ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg";

/** What was remembered from the last export, made valid for this machine. */
function rememberedOptions(enc: Encoders): Options {
  const saved = runtime.remembered<Partial<Options>>(OPTIONS_KEY) ?? {};
  const opts: Options = { ...DEFAULTS, ...saved };
  if (!(opts.format in FORMATS)) {
    opts.format = DEFAULTS.format;
  }
  if (!(opts.quality in QUALITY_LABEL)) {
    opts.quality = DEFAULTS.quality;
  }
  if (opts.speed !== "asPlayed" && opts.speed !== "natural") {
    opts.speed = DEFAULTS.speed;
  }
  if (!(opts.pauses in PAUSE_CAP)) {
    opts.pauses = DEFAULTS.pauses;
  }
  if (missingFor(opts.format, enc)) {
    // The best that works without installing anything: AAC on macOS, else WAV.
    opts.format = missingFor("m4a", enc) ? "wav" : "m4a";
  }
  return opts;
}

export async function exportAudioFlow(back = false): Promise<MenuOutcome> {
  const leave = (): MenuOutcome => (back ? "back" : "closed");
  const buffer = playedAudio();
  if (!buffer || config().exportKeepMinutes <= 0) {
    const OPEN = "Open the setting";
    const pick = await vscode.window.showInformationMessage(
      "Claude Code TTS: keeping spoken audio for export is off (export.keepMinutes is 0). Turn it on, and what is spoken from then on can be exported here.",
      OPEN
    );
    if (pick === OPEN) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "claudeCodeTts.export.keepMinutes");
    }
    return leave();
  }
  if (buffer.pending > 0) {
    // The engine that spoke last is still writing its audio (system voices
    // render it after speaking): a moment, rather than a list missing its
    // last sentence. A moment only; a render that hangs is not waited for.
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Claude Code TTS: finishing the last sentence..." },
      () => Promise.race([buffer.ready(), new Promise<void>((r) => setTimeout(r, 10_000))])
    );
    if (buffer.pending > 0) {
      vscode.window.setStatusBarMessage(
        `Claude Code TTS: ${sentences(buffer.pending)} still being prepared and not in this export yet`,
        8000
      );
    }
  }
  const entries = buffer.list();
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      `Claude Code TTS: nothing has been played yet. The last ${config().exportKeepMinutes} minutes of speech are kept and can be exported from here.`
    );
    return leave();
  }
  const encoders = findEncoders();
  const opts = rememberedOptions(encoders);
  const volume = config().speechConfig.volume;
  for (;;) {
    const scope = await pickScope(entries, volume, back);
    if (scope === "back") {
      return "back";
    }
    if (!scope) {
      return "closed";
    }
    const outcome = await optionsSheet(scope, opts, encoders, volume, buffer);
    if (outcome !== "back") {
      return outcome;
    }
  }
}

interface ScopeRow extends vscode.QuickPickItem {
  entries?: PlayedEntry[];
}

/** Which message, or all of it. Highlighting a row plays its first sentence. */
async function pickScope(
  entries: PlayedEntry[],
  volume: number,
  back: boolean
): Promise<PlayedEntry[] | "back" | undefined> {
  const messages = messagesOf(entries).reverse(); // newest first
  const latest = messages.find((m) => m.group !== undefined) ?? messages[0];
  const describe = (m: PlayedMessage) => `${clock(heardTotal(m.entries))}, ${sentences(m.entries.length)}`;
  const rows: ScopeRow[] = [
    {
      label: "$(comment) The last message",
      description: describe(latest),
      detail: firstWords(latest.entries[0].text, 90),
      entries: latest.entries,
    },
  ];
  if (messages.length > 1) {
    rows.push(
      {
        label: "$(history) Everything kept",
        description: `${clock(heardTotal(entries))}, ${messages.length} messages since ${timeOfDay(entries[0].at)}`,
        detail: "Any part of it can be chosen next",
        entries,
      },
      separator("Messages, newest first"),
      ...messages.map((m) => ({
        label: `$(comment-discussion) ${timeOfDay(m.entries[0].at)}  ${firstWords(m.entries[0].text, 50)}`,
        description: describe(m),
        detail: m.entries.length > 1 ? firstWords(m.entries[1].text, 90) : "",
        entries: m.entries,
      }))
    );
  }
  const picked = await pickWithPreview<ScopeRow>({
    items: rows,
    placeholder: "What to export: move through the rows to hear how each one starts",
    title: "Export spoken audio",
    back,
    preview: (row) => (row.entries?.[0]?.file ? playSample(row.entries[0].file, volume) : undefined),
  });
  if (picked === "back") {
    return "back";
  }
  return picked?.entries;
}

interface SentenceRow extends vscode.QuickPickItem {
  entry: PlayedEntry;
}

/** The sheet: export with what is set, or change one thing and come back. */
async function optionsSheet(
  scope: PlayedEntry[],
  opts: Options,
  encoders: Encoders,
  volume: number,
  buffer: NonNullable<ReturnType<typeof playedAudio>>
): Promise<MenuOutcome> {
  let selected = scope;
  let range: { start: number; end: number } | undefined;
  const speedInUse = (): SpeedChoice => (canStretch(encoders) ? opts.speed : "asIs");
  const segmentsNow = (): Segment[] => timeline(selected, speedInUse(), opts.pauses);
  const spanOf = (segs: Segment[]) => (range ? range.end - range.start : totalSeconds(segs));
  const bytesFor = (format: ExportFormat, quality: ExportQuality, segs: Segment[]) =>
    estimateBytes(format, quality, spanOf(segs), sampleRateOf(segs));
  const tempoOf = (segs: Segment[]) => {
    const total = segs.reduce((n, s) => n + s.entry.seconds, 0);
    return total > 0 ? segs.reduce((n, s) => n + s.entry.seconds * (s.entry.tempo || 1), 0) / total : 1;
  };

  const pickFormat = async (): Promise<unknown> => {
    const segs = segmentsNow();
    const rows = (Object.keys(FORMATS) as ExportFormat[]).map((f) => {
      const missing = missingFor(f, encoders);
      return {
        label: `${f === opts.format ? "$(check) " : ""}${FORMATS[f].label}`,
        description: missing ? `needs ${missing}` : `about ${sizeLabel(bytesFor(f, opts.quality, segs))}`,
        detail: FORMATS[f].detail,
        format: f,
        missing,
      };
    });
    const picked = await pickWithBack(rows, { placeHolder: "Format", title: "Export spoken audio: format" }, true);
    if (!picked || picked === "back") {
      return "back";
    }
    if (picked.missing) {
      await offerCommand(
        `Claude Code TTS: ${FORMATS[picked.format].label} needs ${picked.missing}, which is not installed. Install it and the format is available at once.`,
        ffmpegInstall()
      );
      return "back";
    }
    opts.format = picked.format;
    return "back";
  };

  const pickQuality = async (): Promise<unknown> => {
    const segs = segmentsNow();
    const bitrates = FORMATS[opts.format].bitrates!;
    const why: Record<ExportQuality, string> = {
      small: "The smallest file that is still clear speech",
      good: "Clear speech; the usual choice",
      best: "Indistinguishable from the original",
    };
    const rows = (Object.keys(QUALITY_LABEL) as ExportQuality[]).map((q) => ({
      label: `${q === opts.quality ? "$(check) " : ""}${QUALITY_LABEL[q]}`,
      description: `${bitrates[q]} kbit/s, about ${sizeLabel(bytesFor(opts.format, q, segs))}`,
      detail: why[q],
      quality: q,
    }));
    const picked = await pickWithBack(rows, { placeHolder: "Quality", title: "Export spoken audio: quality" }, true);
    if (picked && picked !== "back") {
      opts.quality = picked.quality;
    }
    return "back";
  };

  const pickRange = async (): Promise<unknown> => {
    const segs = segmentsNow();
    const total = totalSeconds(segs);
    const rate = sampleRateOf(segs);
    const answer = await inputWithBack(
      {
        prompt: `Which part? The selection is ${clock(total)} long. A range like 0:10-1:30 (minutes:seconds), or empty for all of it.`,
        title: "Export spoken audio: range",
        value: range ? `${clock(range.start)}-${clock(range.end)}` : "",
        placeHolder: `0:00-${clock(total)}`,
        validateInput: (v) => {
          const r = parseRange(v, total);
          return typeof r === "string" ? r : undefined;
        },
        hint: (v) => {
          const r = parseRange(v, total);
          if (typeof r === "string") {
            return undefined;
          }
          const span = r ? r.end - r.start : total;
          return `${clock(span)} of audio, about ${sizeLabel(estimateBytes(opts.format, opts.quality, span, rate))} as ${FORMATS[opts.format].label}`;
        },
      },
      true
    );
    if (answer === undefined || answer === BACK) {
      return "back";
    }
    const r = parseRange(answer, total);
    range = r && typeof r === "object" ? r : undefined;
    return "back";
  };

  const pickSentences = async (): Promise<unknown> => {
    const segs = timeline(scope, speedInUse(), opts.pauses);
    const rows: SentenceRow[] = segs.map((s) => ({
      label: firstWords(s.entry.text, 80),
      description: `at ${clock(s.t0)}, ${Math.max(1, Math.round(s.seconds))} s`,
      picked: selected.includes(s.entry),
      entry: s.entry,
    }));
    const picked = await pickManyWithBack<SentenceRow>({
      items: rows,
      placeholder: "Tick the sentences to export; moving through them plays each one",
      title: "Export spoken audio: sentences",
      back: true,
      preview: (row) => (row.entry.file ? playSample(row.entry.file, volume) : undefined),
    });
    if (picked && picked !== "back" && picked.length > 0) {
      const chosen = new Set(picked.map((r) => r.entry));
      selected = scope.filter((e) => chosen.has(e));
      range = undefined; // it was a range of the previous selection
    }
    return "back";
  };

  const pickSpeed = async (): Promise<unknown> => {
    const segs = segmentsNow();
    const tempo = tempoOf(segs);
    const stretchable = canStretch(encoders);
    const rows = [
      {
        label: `${opts.speed === "asPlayed" ? "$(check) " : ""}As played`,
        description: stretchable ? `${tempo.toFixed(2)}x` : "needs ffmpeg",
        detail: "The pace it was heard at, including any speed-up while catching up",
        speed: "asPlayed" as const,
      },
      {
        label: `${opts.speed === "natural" ? "$(check) " : ""}The voice's own pace`,
        description: stretchable ? "1.00x" : "needs ffmpeg",
        detail: "As the engine produced it, whatever rate was set at the time",
        speed: "natural" as const,
      },
    ];
    const picked = await pickWithBack(rows, { placeHolder: "Speed", title: "Export spoken audio: speed" }, true);
    if (!picked || picked === "back") {
      return "back";
    }
    if (!stretchable) {
      await offerCommand(
        "Claude Code TTS: changing the pace of the audio needs ffmpeg, which is not installed. Without it the export is the audio exactly as the voice produced it.",
        ffmpegInstall()
      );
      return "back";
    }
    opts.speed = picked.speed;
    return "back";
  };

  const pickPauses = async (): Promise<unknown> => {
    const rows = [
      {
        label: `${opts.pauses === "natural" ? "$(check) " : ""}Natural`,
        description: "up to 0.6 s",
        detail: "The pauses as they were heard, shortened where the voice waited for the next sentence",
        pauses: "natural" as const,
      },
      {
        label: `${opts.pauses === "tight" ? "$(check) " : ""}Tight`,
        description: "up to 0.15 s",
        detail: "Sentences follow each other closely",
        pauses: "tight" as const,
      },
      {
        label: `${opts.pauses === "asHeard" ? "$(check) " : ""}As heard`,
        description: "up to 4 s",
        detail: "The silences of the moment, including waits for synthesis",
        pauses: "asHeard" as const,
      },
    ];
    const picked = await pickWithBack(
      rows,
      { placeHolder: "Pauses between sentences", title: "Export spoken audio: pauses" },
      true
    );
    if (picked && picked !== "back") {
      opts.pauses = picked.pauses;
    }
    return "back";
  };

  for (;;) {
    const segs = segmentsNow();
    const total = totalSeconds(segs);
    const span = spanOf(segs);
    const bytes = bytesFor(opts.format, opts.quality, segs);
    const bitrate = FORMATS[opts.format].bitrates?.[opts.quality];
    const speed = speedInUse();
    const speedLabel =
      speed === "asIs"
        ? "as produced"
        : speed === "asPlayed"
          ? `as played, ${tempoOf(segs).toFixed(2)}x`
          : "the voice's own pace";
    const pauseLabel = { natural: "natural", tight: "tight", asHeard: "as heard" }[opts.pauses];
    const rows: MenuRow[] = [
      {
        label: "$(export) Export now",
        detail: `${FORMATS[opts.format].label}${bitrate ? ` at ${bitrate} kbit/s` : ""}, ${clock(span)}${range ? ` of ${clock(total)}` : ""}, about ${sizeLabel(bytes)}`,
        run: async () => ((await doExport(segs, range, opts, encoders, buffer)) ? "closed" : undefined),
      },
      separator("Options"),
      {
        label: `$(file-media) Format: ${FORMATS[opts.format].label}`,
        detail: FORMATS[opts.format].detail,
        run: pickFormat,
      },
      ...(bitrate
        ? [
            {
              label: `$(dashboard) Quality: ${QUALITY_LABEL[opts.quality]}, ${bitrate} kbit/s`,
              detail: `About ${sizeLabel(bytes)} for this selection; the other tiers show their sizes too`,
              run: pickQuality,
            },
          ]
        : []),
      {
        label: `$(clock) Range: ${range ? `${clock(range.start)} to ${clock(range.end)}` : `all of it, ${clock(total)}`}`,
        detail: "A start and end time, with the size shown as it is typed",
        run: pickRange,
      },
      {
        label: `$(list-selection) Sentences: ${selected.length === scope.length ? "all" : `${selected.length} of ${scope.length}`}`,
        detail: "Leave sentences out, or hear any of them",
        run: pickSentences,
      },
      {
        label: `$(watch) Speed: ${speedLabel}`,
        detail: "The pace it was heard at, or the voice's own",
        run: pickSpeed,
      },
      { label: `$(debug-pause) Pauses between sentences: ${pauseLabel}`, run: pickPauses },
    ];
    const outcome = await runMenu(rows, `Export spoken audio: ${clock(span)}, about ${sizeLabel(bytes)}`, true);
    if (outcome !== "ran") {
      return outcome;
    }
  }
}

/** Ask where, write it, say what was written. True when a file was exported. */
async function doExport(
  segments: Segment[],
  range: { start: number; end: number } | undefined,
  opts: Options,
  encoders: Encoders,
  buffer: NonNullable<ReturnType<typeof playedAudio>>
): Promise<boolean> {
  const format = FORMATS[opts.format];
  const stamp = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const name = `claude-code-tts-${stamp.getFullYear()}-${two(stamp.getMonth() + 1)}-${two(stamp.getDate())}-${two(stamp.getHours())}${two(stamp.getMinutes())}.${format.ext}`;
  const downloads = path.join(os.homedir(), "Downloads");
  const dir = runtime.remembered<string>(DIR_KEY) ?? (fs.existsSync(downloads) ? downloads : os.homedir());
  const picked = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, name)),
    filters: { [format.label]: [format.ext] },
    saveLabel: "Export",
    title: "Export spoken audio",
  });
  if (!picked) {
    return false;
  }
  // A different extension typed into the save box is a choice too.
  const target = formatForPath(picked.fsPath, opts.format, encoders);
  const uri = vscode.Uri.file(target.path);
  void runtime.remember(DIR_KEY, path.dirname(uri.fsPath));
  void runtime.remember(OPTIONS_KEY, opts);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-tts-export-"));
  const controller = new AbortController();
  const release = buffer.hold();
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Claude Code TTS: exporting...", cancellable: true },
      (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        let shown = 0;
        return exportAudio({
          segments,
          range,
          format: target.format,
          quality: opts.quality,
          encoders,
          out: uri.fsPath,
          workDir,
          signal: controller.signal,
          onProgress: (fraction) => {
            progress.report({ increment: (fraction - shown) * 100 });
            shown = fraction;
          },
        });
      }
    );
    runtime.output.appendLine(`[export] ${uri.fsPath}: ${clock(result.seconds)}, ${sizeLabel(result.bytes)}`);
    const REVEAL = isMac ? "Show in Finder" : isWindows ? "Show in Explorer" : "Show in folder";
    const PLAY = "Play";
    const pick = await vscode.window.showInformationMessage(
      `Claude Code TTS: exported ${clock(result.seconds)} to ${path.basename(uri.fsPath)} (${sizeLabel(result.bytes)}).`,
      REVEAL,
      PLAY
    );
    if (pick === REVEAL) {
      await vscode.commands.executeCommand("revealFileInOS", uri);
    } else if (pick === PLAY) {
      await vscode.env.openExternal(uri);
    }
    return true;
  } catch (e) {
    const message = (e as Error).message;
    if (message !== "cancelled") {
      vscode.window.showErrorMessage(`Claude Code TTS: export failed: ${message}`);
    }
    return false;
  } finally {
    release();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
