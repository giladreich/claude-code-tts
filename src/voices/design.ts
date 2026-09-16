/**
 * "Design a voice": describe a voice in words, get a reusable voice profile.
 * The 1.7B VoiceDesign model renders a ~10s reference reading of the passage
 * for the voice's language once; from then on the voice is a normal clone
 * profile, spoken by Qwen3 on the fast 0.6B Base model or by Chatterbox.
 * Fills the gap in Qwen3's presets (its only English presets are male).
 * Everything runs locally.
 */

import { spawn } from "child_process";
import { pythonEnv } from "../platform/platform";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  designRendersNatively,
  designTargetLanguages,
  languageName,
  profileEnginesFor,
  profileLanguageNote,
} from "../language/language";
import { passageFor } from "./passages";
import { startersFor } from "./starters";
import { chatterboxModelCached, chatterboxReady, renderWithChatterbox } from "../tts/chatterbox";
import { ensureQwen3Runtime, installChatterboxRuntime } from "../setup/setupFlows";
import {
  findQwen3MlxPython,
  findQwen3Python,
  hfModelSnapshot,
  newProfileSlug,
  QWEN3_LANGUAGE_BY_CODE,
  qwen3VoicesDir,
} from "../tts/qwen3";
import { explainPlatformError } from "../platform/platform";
import { reportDownloadIn } from "../ui/statusBar";
import { BACK, Back, inputWithBack, pickWithPreview } from "../ui/prompts";
import { playWavFile } from "../tts/wavPlayers";
import { normalizeReference, trimSilence } from "../tts/wav";

/**
 * The language of the reference the designer renders. It sets the accent of
 * everything the voice later says; the languages the voice can SPEAK are a
 * different, larger set (Chatterbox adds a dozen), which the note spells out.
 * Every language a profile can be spoken in is offered, not just the ten
 * Qwen3 VoiceDesign can render: for the others the reference is rendered in
 * English and re-recorded by Chatterbox in the chosen language.
 */
async function pickLanguage(
  context: vscode.ExtensionContext,
  suggested: string,
  back: boolean
): Promise<string | Back | undefined> {
  const chatterbox = chatterboxReady(context.globalStorageUri.fsPath);
  const picked = await pickWithPreview({
    items: designTargetLanguages().map((code) => ({
      label: languageName(code),
      description: code === suggested ? "suggested" : "",
      detail: designRendersNatively(code)
        ? `Rendered from a ${languageName(code)} passage, so it sounds native in ${languageName(code)}. ${profileLanguageNote(code, chatterbox)}`
        : `The designer cannot read ${languageName(code)}, so the reference is rendered in English and Chatterbox speaks ${languageName(code)} with it. Measured as accurate as a native reference; the accent may lean English. ${profileLanguageNote(code, chatterbox)}`,
      code,
    })),
    placeholder: "Which language is this voice for? (the voice speaks the others too)",
    title: "Design a voice: language",
    back,
    preview: () => undefined,
  });
  return picked === "back" ? BACK : picked?.code;
}

/**
 * A language no cloning engine speaks at all (Czech, Thai, ...). Says what is
 * possible instead of failing later. Languages the designer cannot RENDER but
 * Chatterbox can SPEAK are not sent here: the picker offers them and borrows
 * an English passage for the reference.
 */
async function explainUndesignable(code: string): Promise<"pick" | undefined> {
  const name = languageName(code);
  if (profileEnginesFor(code).length === 0) {
    const pick = await vscode.window.showInformationMessage(
      `Claude Code TTS: no engine can speak ${name} in a designed or cloned voice yet. ${name} is spoken by the Piper ${name} voice; a voice you design would give other languages a ${name} accent at most.`,
      { modal: true },
      `Download a ${name} voice`
    );
    if (pick) {
      await vscode.commands.executeCommand("claudeCodeTts.downloadVoiceForLanguage", code);
    }
    return undefined;
  }
  // Any language a cloning engine speaks is offered by the picker, so this
  // point is only reached for one that none of them speaks.
  return undefined;
}

export function playSample(file: string, volume: number): { stop: () => void } {
  const handle = playWavFile(file, volume);
  if (!handle.playing) {
    vscode.window.showWarningMessage(
      "Claude Code TTS: no audio player was found for auditions. Install ffmpeg (ffplay), sox, or pulseaudio-utils to hear samples."
    );
  }
  return handle;
}

/** Render the passage with the VoiceDesign model into `out`. */
export function render(
  python: string,
  script: string,
  instruct: string,
  language: string,
  passage: string,
  out: string,
  logFile: string,
  cached: boolean
): Thenable<{ ok: boolean; error?: string }> {
  const modelId = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16";
  const torchId = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";
  const mlx = python === findQwen3MlxPython();
  const id = mlx ? modelId : torchId;
  const snapshot = hfModelSnapshot(id);
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: cached
        ? "Claude Code TTS: designing the voice (about half a minute)..."
        : "Claude Code TTS: designing the voice",
      cancellable: true,
    },
    (progress, token) =>
      new Promise((resolve) => {
        // The first design fetches the designer's own model, a wait of
        // minutes: this notification carries how far it is (the bytes, the
        // percentage, the bar) rather than pointing at the status bar.
        const stopReporting = cached
          ? undefined
          : reportDownloadIn(progress, {
              fetching: "fetching its own model first (~4.2 GB, once)",
              afterFetch: "model fetched; loading it and rendering (about half a minute)...",
            });
        const finish = (result: { ok: boolean; error?: string }) => {
          stopReporting?.();
          resolve(result);
        };
        const cfg = { model_id: snapshot ?? id, instruct, text: passage, language, out };
        const proc = spawn(python, [script, JSON.stringify(cfg)], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: pythonEnv(),
        });
        try {
          fs.writeFileSync(logFile, `${new Date().toISOString()} start ${python} ${script}\n`);
        } catch {}
        proc.stderr?.on("data", (d) => fs.appendFile(logFile, String(d), () => {}));
        let stdout = "";
        proc.stdout?.on("data", (d) => (stdout += d.toString()));
        token.onCancellationRequested(() => proc.kill("SIGKILL"));
        proc.on("exit", (code) => {
          try {
            const last = stdout.trim().split("\n").pop() ?? "";
            const msg = JSON.parse(last);
            finish({ ok: msg.ok === true, error: msg.error ? String(msg.error) : undefined });
          } catch {
            finish({ ok: false, error: token.isCancellationRequested ? "cancelled" : `exited with ${code}` });
          }
        });
        proc.on("error", (e) => finish({ ok: false, error: e.message }));
      })
  );
}

export function voiceDesignModelCached(): boolean {
  return (
    hfModelSnapshot("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16") !== undefined ||
    hfModelSnapshot("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign") !== undefined
  );
}

/**
 * Interactive flow. Returns the new voice value ("clone:<slug>") or undefined.
 */
export async function designVoiceFlow(
  context: vscode.ExtensionContext,
  volume: number,
  /** Language the voice should speak natively; asked for when not given. */
  presetLanguage?: string,
  /**
   * Make sure the engine that re-records the reference can read this
   * language, before it does: a writing system whose vowels are not written
   * needs a package the engine's runtime may not have, and a reference
   * recorded without it is mispronounced speech stored as the voice itself.
   */
  prepareText?: (code: string) => Promise<void>
): Promise<string | undefined> {
  if (!(await ensureQwen3Runtime("Designing a voice"))) {
    return undefined;
  }
  const python = findQwen3MlxPython() ?? findQwen3Python();
  const script = path.join(context.extensionPath, "assets", "qwen3_design.py");
  if (!python || !fs.existsSync(script)) {
    vscode.window.showWarningMessage(
      "Claude Code TTS: Qwen3-TTS installed but could not be found afterwards (see the log)."
    );
    return undefined;
  }
  // The passage is rendered in this language and stored as the reference,
  // which is what decides the accent of everything the voice later says.
  let code = presetLanguage;
  if (code && !designTargetLanguages().includes(code)) {
    if ((await explainUndesignable(code)) !== "pick") {
      return undefined;
    }
    code = undefined;
  }
  // Three questions, and any of them can be reconsidered: leaving one goes
  // back to the one before it rather than out of the flow, which is the
  // whole point of a flow with steps in it. Leaving the first one leaves the
  // flow, back to the list that opened it.
  const asksLanguage = code === undefined;
  const CUSTOM = "$(edit) Describe a voice in your own words...";
  let starters = startersFor(code ?? "en");
  let starting = "";
  let startingLabel = "";
  let instruct = "";
  for (let step = asksLanguage ? 0 : 1; step < 3;) {
    if (step === 0) {
      const speak = vscode.workspace.getConfiguration("claudeCodeTts").get<string>("speakLanguage", "");
      const picked = await pickLanguage(context, designTargetLanguages().includes(speak) ? speak : "en", true);
      if (picked === undefined || picked === BACK) {
        return undefined;
      }
      code = picked;
      starters = startersFor(code);
      step = 1;
      continue;
    }
    if (step === 1) {
      const pick = await pickWithPreview({
        items: [
          ...starters.map((s) => ({ label: s.label, detail: s.detail, instruct: s.instruct })),
          { label: CUSTOM, detail: "Gender, age, accent, tone, pace: anything the model should aim for", instruct: "" },
        ],
        placeholder: "Start from a description (you can edit it next); describe a voice, not a specific real person",
        title: `Design a voice: ${languageName(code!)}`,
        back: true,
        preview: () => undefined,
      });
      if (!pick) {
        return undefined;
      }
      if (pick === "back") {
        // The language was decided elsewhere
        if (!asksLanguage) {
          return undefined;
        }
        step = 0;
        continue;
      }
      starting = pick.instruct || starters[0].instruct;
      startingLabel = pick.label === CUSTOM ? "" : pick.label;
      step = 2;
      continue;
    }
    const renders = designRendersNatively(code!);
    const typed = await inputWithBack(
      {
        prompt: `Describe the voice${renders ? ` (it will read a ${languageName(code!)} passage)` : ` (rendered from an English passage, then re-recorded speaking ${languageName(code!)})`}`,
        title: "Design a voice: description",
        value: starting,
        validateInput: (v) => (v.trim().length >= 10 ? undefined : "Say a little more about the voice"),
      },
      true
    );
    if (typed === undefined) {
      return undefined;
    }
    if (typed === BACK) {
      step = 1;
      continue;
    }
    instruct = typed;
    step = 3;
  }
  if (!code || !instruct) {
    return undefined;
  }
  // The renderer only speaks Qwen3's ten languages. For the others the
  // reference is an English passage; the voice still speaks the language it
  // was designed for, because Chatterbox supplies the pronunciation and the
  // reference supplies only the timbre.
  const renderCode = designRendersNatively(code) ? code : "en";
  const language = QWEN3_LANGUAGE_BY_CODE[renderCode] ?? "English";
  const passage = passageFor(renderCode);

  // The re-recording is what gives the voice its accent in the language it
  // is for, and Chatterbox is what does it: asked for and installed now,
  // before minutes of rendering, rather than found missing after them,
  // when all that was left was to keep the borrowed reference and say so.
  if (renderCode !== code && !chatterboxReady(context.globalStorageUri.fsPath)) {
    const installed = await installChatterboxRuntime(true);
    if (!installed) {
      const go = await vscode.window.showWarningMessage(
        `Claude Code TTS: without Chatterbox the reference stays the ${languageName(renderCode)} recording, and the voice speaks ${languageName(code)} with a ${languageName(renderCode)} accent for good. Design it that way?`,
        { modal: true },
        "Design anyway"
      );
      if (go !== "Design anyway") {
        return undefined;
      }
    }
  }

  // 4.2 GB is not something to start behind a progress bar someone may not
  // be watching. Asked once: after the first design the model is on disk and
  // this never appears again.
  if (!voiceDesignModelCached()) {
    const go = await vscode.window.showInformationMessage(
      "Designing a voice needs the VoiceDesign model: about 4.2 GB, downloaded once, then it works offline. The download can be cancelled and resumes next time.",
      { modal: true },
      "Download and design"
    );
    if (go !== "Download and design") {
      return undefined;
    }
  }

  const dir = qwen3VoicesDir(context.globalStorageUri.fsPath);
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(context.globalStorageUri.fsPath, "qwen3-design.log");

  // Every rendering is kept as a take until the flow ends: results vary per
  // run, and "try again" used to throw the previous one away, so a take that
  // turned out to be the best was gone by the time that was clear. The list
  // plays each one as it is highlighted, and the name step comes back here.
  const takes: Take[] = [];
  const discard = (keep?: Take) => {
    for (const t of takes) {
      if (t !== keep) {
        fs.rmSync(t.wav, { force: true });
      }
    }
  };
  let next: "render" | "choose" = "render";
  for (;;) {
    if (next === "render") {
      const tmpWav = path.join(dir, `.design-${Date.now()}.wav`);
      const outcome = await renderTake(tmpWav);
      if (outcome === "cancelled" || (outcome === undefined && takes.length === 0)) {
        discard();
        return undefined;
      }
      if (outcome) {
        takes.push(outcome);
      }
      next = "choose";
      continue;
    }
    const picked = await chooseTake(takes, instruct, volume);
    if (picked === "another") {
      next = "render";
      continue;
    }
    if (picked === "describe") {
      const typed = await inputWithBack(
        {
          prompt: "Change the description and render another take with it (the takes so far are kept)",
          title: "Design a voice: description",
          value: instruct,
          validateInput: (v) => (v.trim().length >= 10 ? undefined : "Say a little more about the voice"),
        },
        true
      );
      if (typed && typed !== BACK) {
        instruct = typed;
        next = "render";
      }
      continue;
    }
    if (!picked) {
      discard();
      return undefined;
    }
    const chosen = picked;
    const name = await inputWithBack(
      {
        prompt: "Name this voice",
        title: "Design a voice: name",
        value: startingLabel || "Designed voice",
        validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
      },
      true
    );
    if (!name || name === BACK) {
      continue; // back to the takes: a rendering costs minutes and is not thrown away over a name
    }
    const slug = newProfileSlug(dir, name);
    const profileDir = path.join(dir, slug);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.renameSync(chosen.wav, path.join(profileDir, "ref.wav"));
    discard(chosen);
    fs.writeFileSync(
      path.join(profileDir, "meta.json"),
      JSON.stringify(
        {
          name: name.trim(),
          // The transcript has to match the audio: when the reference was
          // re-recorded in the target language, that is the passage it read.
          refText: chosen.referenceLanguage === code ? passageFor(code) : passage,
          passage: chosen.referenceLanguage === code ? passageFor(code) : passage,
          language: code,
          usedTranscript: true, // synthesized from the passage: the text is exact
          designed: true,
          description: chosen.instruct,
          createdAt: new Date().toISOString(),
          trimmed: true,
        },
        null,
        2
      )
    );
    return `clone:${slug}`;
  }

  /**
   * One rendering with the description as it stands: the reference, then a
   * re-recording in the voice's language where the designer cannot read it.
   * Undefined when nothing usable came out (said on screen); "cancelled" when
   * the person stopped it.
   */
  async function renderTake(tmpWav: string): Promise<Take | "cancelled" | undefined> {
    const description = instruct.trim();
    const result = await render(
      python!,
      script,
      description,
      language,
      passage,
      tmpWav,
      logFile,
      voiceDesignModelCached()
    );
    if (!result.ok) {
      fs.rmSync(tmpWav, { force: true });
      if (result.error === "cancelled") {
        return "cancelled";
      }
      vscode.window
        .showErrorMessage(
          `Claude Code TTS: voice design failed: ${explainPlatformError(result.error ?? "unknown error")}`,
          "Show log"
        )
        .then((p) => p && vscode.workspace.openTextDocument(logFile).then((d) => vscode.window.showTextDocument(d)));
      return undefined;
    }
    const { seconds } = trimSilence(tmpWav);
    if (seconds < 4) {
      fs.rmSync(tmpWav, { force: true });
      vscode.window.showErrorMessage(
        "Claude Code TTS: the model produced almost no speech for that description; try a different one."
      );
      return undefined;
    }
    normalizeReference(tmpWav);

    // The designer just read an English passage. For a voice meant for a
    // language it cannot read, that English recording would become the
    // reference and give the voice an English accent for good. Chatterbox
    // speaks the language, so it re-records the same voice reading THAT
    // language's passage, and the reference stored is speech in the language
    // the voice is for.
    let referenceLanguage = renderCode;
    if (renderCode !== code) {
      await prepareText?.(code!);
      const runtimePref = vscode.workspace.getConfiguration("claudeCodeTts").get<string>("chatterbox.runtime", "auto");
      // The first recording fetches Chatterbox's own weights, minutes of
      // waiting that used to pass under "recording the voice": the
      // notification says what is being fetched and why, and how far it is
      // (bytes, percentage, bar), as the other downloads do.
      const cached = chatterboxModelCached(context.globalStorageUri.fsPath, runtimePref);
      const spoken = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Claude Code TTS: recording the voice in ${languageName(code!)}`,
        },
        async (progress) => {
          let stopReporting: (() => void) | undefined;
          if (cached) {
            progress.report({ message: "loading the model and recording (about a minute)..." });
          } else {
            stopReporting = reportDownloadIn(progress, {
              fetching: `Chatterbox, which speaks ${languageName(code!)}, fetches its model first (~2.5 GB, once)`,
              afterFetch: "model fetched; loading it and recording...",
            });
          }
          try {
            return await renderWithChatterbox({
              globalStoragePath: context.globalStorageUri.fsPath,
              daemonScript: path.join(context.extensionPath, "assets", "chatterbox_daemon.py"),
              runtime: runtimePref,
              text: passageFor(code),
              language: code!,
              refWav: tmpWav,
              outWav: `${tmpWav}.native.wav`,
            });
          } finally {
            stopReporting?.();
          }
        }
      );
      if (spoken && trimSilence(`${tmpWav}.native.wav`).seconds >= 4) {
        normalizeReference(`${tmpWav}.native.wav`);
        fs.renameSync(`${tmpWav}.native.wav`, tmpWav);
        referenceLanguage = code!;
      } else {
        fs.rmSync(`${tmpWav}.native.wav`, { force: true });
        vscode.window.showWarningMessage(
          `Claude Code TTS: the voice was designed, but it could not be re-recorded in ${languageName(code!)} (Chatterbox is what speaks it). Keeping the English reference, which speaks ${languageName(code!)} with an English accent.`
        );
      }
    }
    const heard =
      referenceLanguage === code
        ? languageName(code)
        : `${languageName(renderCode)} (its ${languageName(code!)} accent could not be recorded)`;
    return { wav: tmpWav, seconds: trimSilence(tmpWav).seconds, heard, referenceLanguage, instruct: description };
  }
}

/** One rendering of the voice, kept until the flow ends. */
export interface Take {
  wav: string;
  seconds: number;
  /** What the reference is heard in, for the row. */
  heard: string;
  referenceLanguage: string;
  /** The description this take was rendered from. */
  instruct: string;
}

interface TakeRow extends vscode.QuickPickItem {
  take?: Take;
  action?: "another" | "describe";
}

/**
 * The rows of the takes list, newest first, so the one just rendered is
 * under the cursor. A take made from another description says so, since the
 * description can change between takes.
 */
export function takeRows(takes: Take[], instruct: string): TakeRow[] {
  const rows: TakeRow[] = takes
    .map((t, i) => ({
      label: `$(play) Take ${i + 1}`,
      description: `${Math.round(t.seconds)}s, heard in ${t.heard}`,
      detail:
        i === takes.length - 1
          ? "The latest take"
          : t.instruct !== instruct.trim()
            ? `From an earlier description: ${t.instruct.slice(0, 80)}${t.instruct.length > 80 ? "..." : ""}`
            : "",
      take: t,
    }))
    .reverse();
  rows.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(refresh) Render another take",
      detail: "The same description; every take comes out different",
      action: "another",
    },
    {
      label: "$(edit) Change the description...",
      detail: "Render a take from new words; the takes so far are kept",
      action: "describe",
    }
  );
  return rows;
}

/** Which take to keep. Undefined leaves the flow, and the takes with it. */
async function chooseTake(
  takes: Take[],
  instruct: string,
  volume: number
): Promise<Take | "another" | "describe" | undefined> {
  const picked = await pickWithPreview<TakeRow>({
    items: takeRows(takes, instruct),
    placeholder:
      takes.length === 1
        ? "This is the designed voice reading the passage. Enter keeps it; or render another take to compare"
        : `${takes.length} takes: move through them to hear each one, Enter keeps the one you like`,
    title: "Design a voice: takes",
    // The newest take is the first row, and hearing it is what the person
    // has been waiting half a minute for: it plays as the list opens.
    playFirst: true,
    preview: (row) => (row.take ? playSample(row.take.wav, volume) : undefined),
  });
  if (!picked || picked === "back") {
    return undefined;
  }
  return picked.action ?? picked.take;
}
