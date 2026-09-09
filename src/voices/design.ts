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
import { chatterboxReady, renderWithChatterbox } from "../tts/chatterbox";
import { ensureQwen3Runtime } from "../setup/setupFlows";
import {
  findQwen3MlxPython,
  findQwen3Python,
  hfModelSnapshot,
  newProfileSlug,
  QWEN3_LANGUAGE_BY_CODE,
  qwen3VoicesDir,
} from "../tts/qwen3";
import { BACK, Back, inputWithBack, pickWithPreview } from "../ui/prompts";
import { playWavFile } from "../tts/synthPlay";
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
        : "Claude Code TTS: fetching the voice designer's own model (~4.2 GB, one-time; the status bar counts it down), then designing the voice...",
      cancellable: true,
    },
    (_progress, token) =>
      new Promise((resolve) => {
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
            resolve({ ok: msg.ok === true, error: msg.error ? String(msg.error) : undefined });
          } catch {
            resolve({ ok: false, error: token.isCancellationRequested ? "cancelled" : `exited with ${code}` });
          }
        });
        proc.on("error", (e) => resolve({ ok: false, error: e.message }));
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

  for (;;) {
    const tmpWav = path.join(dir, `.design-${Date.now()}.wav`);
    const result = await render(
      python,
      script,
      instruct.trim(),
      language,
      passage,
      tmpWav,
      logFile,
      voiceDesignModelCached()
    );
    if (!result.ok) {
      fs.rmSync(tmpWav, { force: true });
      if (result.error !== "cancelled") {
        vscode.window
          .showErrorMessage(`Claude Code TTS: voice design failed: ${result.error ?? "unknown error"}`, "Show log")
          .then((p) => p && vscode.workspace.openTextDocument(logFile).then((d) => vscode.window.showTextDocument(d)));
      }
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
      await prepareText?.(code);
      const spoken = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Claude Code TTS: recording the voice in ${languageName(code)}...`,
        },
        () =>
          renderWithChatterbox({
            globalStoragePath: context.globalStorageUri.fsPath,
            daemonScript: path.join(context.extensionPath, "assets", "chatterbox_daemon.py"),
            runtime: vscode.workspace.getConfiguration("claudeCodeTts").get<string>("chatterbox.runtime", "auto"),
            text: passageFor(code),
            language: code,
            refWav: tmpWav,
            outWav: `${tmpWav}.native.wav`,
          })
      );
      if (spoken && trimSilence(`${tmpWav}.native.wav`).seconds >= 4) {
        normalizeReference(`${tmpWav}.native.wav`);
        fs.renameSync(`${tmpWav}.native.wav`, tmpWav);
        referenceLanguage = code;
      } else {
        fs.rmSync(`${tmpWav}.native.wav`, { force: true });
        vscode.window.showWarningMessage(
          `Claude Code TTS: the voice was designed, but it could not be re-recorded in ${languageName(code)} (Chatterbox is what speaks it). Keeping the English reference, which speaks ${languageName(code)} with an English accent.`
        );
      }
    }
    const heard =
      referenceLanguage === code
        ? languageName(code)
        : `${languageName(renderCode)} (its ${languageName(code)} accent could not be recorded)`;

    const sample = playSample(tmpWav, volume);
    const choice = await vscode.window.showInformationMessage(
      `This is the designed voice, reading the reference passage in ${heard}. Keep it?`,
      { modal: true },
      "Keep this voice",
      "Try again"
    );
    sample.stop();
    if (choice === "Try again") {
      fs.rmSync(tmpWav, { force: true });
      continue; // same description, a fresh render (results vary per run)
    }
    if (choice !== "Keep this voice") {
      fs.rmSync(tmpWav, { force: true });
      return undefined;
    }

    const name = await inputWithBack({
      prompt: "Name this voice",
      title: "Design a voice: name",
      value: startingLabel || "Designed voice",
      validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
    });
    if (!name || name === BACK) {
      // The voice was rendered and kept; only the name is missing, and
      // throwing the render away over that would cost minutes of GPU time.
      fs.rmSync(tmpWav, { force: true });
      return undefined;
    }
    const slug = newProfileSlug(dir, name);
    const profileDir = path.join(dir, slug);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.renameSync(tmpWav, path.join(profileDir, "ref.wav"));
    fs.writeFileSync(
      path.join(profileDir, "meta.json"),
      JSON.stringify(
        {
          name: name.trim(),
          // The transcript has to match the audio: when the reference was
          // re-recorded in the target language, that is the passage it read.
          refText: referenceLanguage === code ? passageFor(code) : passage,
          passage: referenceLanguage === code ? passageFor(code) : passage,
          language: code,
          usedTranscript: true, // synthesized from the passage: the text is exact
          designed: true,
          description: instruct.trim(),
          createdAt: new Date().toISOString(),
          trimmed: true,
        },
        null,
        2
      )
    );
    return `clone:${slug}`;
  }
}
