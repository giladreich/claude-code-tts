/**
 * Guided voice cloning for the engines that speak voice profiles (Qwen3 and
 * Chatterbox): the user reads the passage for their language aloud (~10s, and
 * the recorder stops at 20), taken by a tiny compiled Swift helper on macOS
 * and by ffmpeg elsewhere; the passage doubles as the reference transcript the
 * cloner wants for best quality. Cloning from an audio or video file already
 * on the machine is here too. The recording never leaves the machine.
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findQwen3Python, listQwen3Clones, newProfileSlug, qwen3Available, qwen3VoicesDir } from "../tts/qwen3";
import { chatterboxPython } from "../tts/chatterbox";
import { hfModelSnapshot } from "../tts/qwen3";
import { killProcess } from "../tts/types";
import { normalizeReference, repairWavHeader, trimSilence } from "../tts/wav";
import { languageName, profileLanguageNote } from "../language/language";
import { BACK, inputWithBack, offerCommand, pickWithPreview } from "../ui/prompts";
import { chatterboxReady } from "../tts/chatterbox";
import { passageFor, PASSAGE_LANGUAGES } from "./passages";
import { AFTER_INSTALL_HINT, hasCommand, packageInstallCommand, pythonEnv, uvToolPython } from "../platform/platform";
import { ensureCloneConsent } from "./consent";

// Kept deliberately short: Qwen3-TTS clones from a few seconds of speech and
// long references degrade quality (the model starts babbling the reference).
// About 10 seconds at a natural pace, phonetically varied.
/** Kept for compatibility with profiles recorded before languages existed. */
export const CLONE_PASSAGE = passageFor("en");

/**
 * The language of the recording, asked before it is made. It fixes the
 * accent; which languages the voice can then SPEAK depends on the engines
 * that clone (Qwen3, Chatterbox), and the note says so per language rather
 * than promising "native X" for a language nothing here can clone.
 */
export async function pickCloneLanguage(storagePath: string): Promise<string | undefined> {
  const speak = vscode.workspace.getConfiguration("claudeCodeTts").get<string>("speakLanguage", "");
  const chatterbox = chatterboxReady(storagePath);
  const picked = await pickWithPreview({
    items: PASSAGE_LANGUAGES.map((code) => ({
      label: languageName(code),
      description: code === (speak || "en") ? "suggested" : "",
      detail: `You read a short ${languageName(code)} passage. ${profileLanguageNote(code, chatterbox)}`,
      code,
    })),
    placeholder: "Which language will you speak in the recording? (sets the accent)",
    title: "Clone your voice: language",
    back: true,
    preview: () => undefined,
  });
  return picked === "back" || !picked ? undefined : picked.code;
}

// Generous window: being cut off mid-passage leaves reference text the audio
// does not contain, and the cloner then "continues" it before the real text.
const MAX_SECONDS = 20;

/** Word-level overlap ratio between two texts (0-1). */
function wordOverlap(a: string, b: string): number {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const wa = norm(a),
    wb = new Set(norm(b));
  if (wa.length === 0) {
    return 0;
  }
  return wa.filter((w) => wb.has(w)).length / wa.length;
}

/**
 * A Python that can run assets/transcribe.py: it needs numpy and either MLX or
 * torch, which every engine venv this extension installs has. Only the
 * qwen-tts venv used to be considered, so on an Apple Silicon machine set up
 * for MLX the check quietly did nothing and the voice picker then told the
 * user their recording did not match its transcript.
 */
function transcriptionPython(storagePath: string): string | undefined {
  return findQwen3Python() ?? chatterboxPython(storagePath) ?? uvToolPython("mlx-audio", "transformers");
}

/** One JSON line from assets/transcribe.py, or undefined if it could not say one. */
function transcribeJson(
  python: string,
  args: string[],
  timeoutMs: number
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const proc = spawn(python, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: pythonEnv() });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(undefined);
    }, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? ""));
      } catch {
        resolve(undefined);
      }
    });
    proc.on("error", () => resolve(undefined));
  });
}

/**
 * An engine that can speak a voice profile, or an offer to install one.
 * Cloning used to be gated on Qwen3 alone, which made Chatterbox a dead end:
 * it is mute until a profile exists, and the only flow that creates one
 * refused to run without the other engine.
 */
export async function ensureProfileEngine(context: vscode.ExtensionContext): Promise<boolean> {
  const storage = context.globalStorageUri.fsPath;
  if (qwen3Available() || chatterboxReady(storage)) {
    return true;
  }
  const pick = await vscode.window.showInformationMessage(
    "Claude Code TTS: a voice you create needs an engine that can speak it. Chatterbox speaks 23 languages in your voice, Qwen3 is lighter and speaks 10.",
    "Set up Chatterbox",
    "Set up Qwen3"
  );
  if (!pick) {
    return false;
  }
  const voicesDir = qwen3VoicesDir(storage);
  const before = listQwen3Clones(voicesDir).length;
  await vscode.commands.executeCommand(
    pick === "Set up Chatterbox" ? "claudeCodeTts.setupChatterbox" : "claudeCodeTts.setupQwen3"
  );
  // The setup flows offer to create a voice when they finish, because an
  // engine that speaks profiles is mute without one. If the user took that
  // offer, the flow that led here has already got what it wanted: carrying
  // on would ask them to record the same voice a second time.
  if (listQwen3Clones(voicesDir).length > before) {
    return false;
  }
  return qwen3Available() || chatterboxReady(storage);
}

/**
 * Transcribe the recording with Whisper when a capable Python exists.
 * Returns undefined when unavailable or on failure.
 */
export async function transcribeRecording(
  context: vscode.ExtensionContext,
  wav: string,
  language = "en"
): Promise<string | undefined> {
  const python = transcriptionPython(context.globalStorageUri.fsPath);
  const script = path.join(context.extensionPath, "assets", "transcribe.py");
  if (!python || !fs.existsSync(script)) {
    return undefined;
  }
  // Which model this Python will fetch is the script's decision, not this
  // file's: an MLX environment has no torch and reads different weights than
  // a PyTorch one. Asking it keeps the size quoted here true, and hardcoding
  // the transformers model is what made the check say 150 MB for a 967 MB
  // download it could not even run.
  const plan = await transcribeJson(python, [script, "--plan", language], 30_000);
  const model = typeof plan?.model === "string" ? plan.model : undefined;
  if (!model) {
    return undefined;
  }
  // The check runs a speech-recognition model, and the first run downloads
  // it. Worth asking: a clone works without the check (the passage on screen
  // becomes the reference text), and half a gigabyte is not a surprise to
  // spring.
  if (!hfModelSnapshot(model)) {
    const size = typeof plan?.mb === "number" ? `about ${plan.mb} MB` : "several hundred megabytes";
    const go = await vscode.window.showInformationMessage(
      `Check that the recording matches what you read? It transcribes on this machine with a speech-recognition model, downloaded once (${size}). Skipping it uses the passage on screen as the reference text.`,
      { modal: true },
      "Check it"
    );
    if (go !== "Check it") {
      return undefined;
    }
  }
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title:
        language === "en"
          ? "Claude Code TTS: checking your recording..."
          : `Claude Code TTS: checking your recording (${languageName(language)} model, first use downloads it)...`,
    },
    async () => {
      const msg = await transcribeJson(python, [script, wav, language], 240_000);
      return typeof msg?.text === "string" && msg.text.length > 0 ? msg.text : undefined;
    }
  );
}

/**
 * A compiled helper is reusable only while it is newer than the source it was
 * built from. The name carries a version for protocol changes, but an update
 * that edits the Swift and forgets to bump it would otherwise keep running
 * the binary built from the old code, for as long as the user keeps their
 * storage directory.
 */
function upToDate(bin: string, source: string): boolean {
  try {
    return fs.statSync(bin).mtimeMs >= fs.statSync(source).mtimeMs;
  } catch {
    return false;
  }
}

const MIC_BIN = "claude-code-tts-mic-v1";

/** Compile a bundled Swift helper once into the extension's storage (macOS). */
export async function ensureSwiftHelper(
  context: vscode.ExtensionContext,
  binName: string,
  sourceName: string,
  what: string
): Promise<string | undefined> {
  const bin = path.join(context.globalStorageUri.fsPath, "bin", binName);
  const source = path.join(context.extensionPath, "assets", sourceName);
  if (upToDate(bin, source)) {
    return bin;
  }
  const haveOlder = fs.existsSync(bin);
  if (spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status !== 0 || !fs.existsSync(source)) {
    // A helper built by an earlier version still works: a source file whose
    // timestamp moved is no reason to send the user to install Xcode tools.
    if (haveOlder) {
      return bin;
    }
    void offerCommand(
      `Claude Code TTS: ${what} needs Apple's CommandLineTools to build a tiny helper once (a one-time install, no Xcode needed).`,
      "xcode-select --install"
    );
    return undefined;
  }
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Claude Code TTS: preparing ${what} (one-time)` },
    () =>
      new Promise<boolean>((resolve) => {
        const proc = spawn("swiftc", ["-O", "-o", bin, source], { stdio: "ignore" });
        proc.on("exit", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      })
  );
  if (!ok) {
    if (haveOlder) {
      return bin;
    }
    vscode.window.showErrorMessage(`Claude Code TTS: building the ${what} helper failed.`);
    return undefined;
  }
  return bin;
}

function ensureMicRecorder(context: vscode.ExtensionContext): Promise<string | undefined> {
  return ensureSwiftHelper(context, MIC_BIN, "micrecord.swift", "the recorder");
}

/**
 * Audio input devices ffmpeg's DirectShow backend reports (Windows). ffmpeg
 * prints them on stderr; there is no machine-readable form. The first entry
 * is often "Stereo Mix" or a webcam, so the user picks when there are
 * several rather than silently recording the wrong input.
 */
function dshowAudioDevices(): string[] {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  const text = `${r.stderr ?? ""}`;
  return [...text.matchAll(/"([^"]+)"\s*\(audio\)/g)].map((m) => m[1]);
}

async function chooseWindowsInput(): Promise<string | undefined> {
  const devices = dshowAudioDevices();
  if (devices.length === 0) {
    return undefined;
  }
  if (devices.length === 1) {
    return devices[0];
  }
  const picked = await pickWithPreview({
    items: devices.map((label) => ({ label })),
    placeholder: "Which microphone should record? (ffmpeg DirectShow inputs)",
    title: "Clone your voice: microphone",
    back: true,
    preview: () => undefined,
  });
  return picked === "back" || !picked ? undefined : picked.label;
}

/** Linux capture backends worth trying, best first. */
function linuxCaptureInputs(): string[][] {
  return [
    ["-f", "pulse", "-i", "default"], // PulseAudio and PipeWire's pulse layer
    ["-f", "alsa", "-i", "default"],
  ];
}

/** How this machine can record from the microphone, if at all. */
export function recorderKind(): "swift" | "ffmpeg" | undefined {
  if (process.platform === "darwin" && spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status === 0) {
    return "swift";
  }
  return hasCommand("ffmpeg") ? "ffmpeg" : undefined;
}

/**
 * Record the microphone to a 24kHz mono WAV. macOS uses the bundled Swift
 * helper (no dependencies); elsewhere ffmpeg does the same job with the
 * platform's capture backend, so cloning is not a macOS-only feature.
 */
function recordWithFfmpeg(
  outFile: string,
  maxSeconds: number,
  input: string[]
): { finished: Promise<{ ok: boolean; error: string }>; stop: () => void } {
  const proc = spawn(
    "ffmpeg",
    // prettier-ignore
    [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      ...input,
      "-ac", "1",
      "-ar", "24000",
      "-t", String(maxSeconds),
      outFile,
    ],
    { stdio: ["pipe", "ignore", "pipe"], windowsHide: true }
  );
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += String(d)));
  const finished = new Promise<{ ok: boolean; error: string }>((resolve) => {
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
    proc.on("exit", () => {
      // Stopped the hard way (see below): the header still says zero bytes.
      repairWavHeader(outFile);
      resolve({
        ok: fs.existsSync(outFile) && fs.statSync(outFile).size > 1000,
        error: stderr.trim().split("\n").slice(-2).join(" ").slice(-300),
      });
    });
  });
  // "q" asks ffmpeg to stop and finalise the file; killing it truncates. On
  // Windows ffmpeg reads that key from the console and never from a pipe, so
  // when the ask goes unanswered it is stopped the hard way after a moment,
  // and the exit handler above repairs what that leaves.
  const stop = () => {
    proc.stdin?.write("q");
    const fallback = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        killProcess(proc);
      }
    }, 1500);
    fallback.unref?.();
  };
  return { finished, stop };
}

function record(bin: string, outFile: string): Thenable<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Claude Code TTS: recording - read the passage aloud",
      cancellable: true, // Cancel = finish early and keep what was recorded
    },
    (progress, token) =>
      new Promise<boolean>((resolve) => {
        const proc = spawn(bin, [outFile, String(MAX_SECONDS)], { stdio: ["pipe", "pipe", "ignore"] });
        let elapsed = 0;
        const tick = setInterval(() => {
          elapsed++;
          progress.report({
            increment: 100 / MAX_SECONDS,
            message: `${elapsed}s (press Cancel to finish early)`,
          });
        }, 1000);
        token.onCancellationRequested(() => proc.stdin?.write("\n"));
        let out = "";
        proc.stdout?.on("data", (d) => (out += d.toString()));
        proc.on("exit", () => {
          clearInterval(tick);
          try {
            resolve(JSON.parse(out.trim()).ok === true);
          } catch {
            resolve(false);
          }
        });
        proc.on("error", () => {
          clearInterval(tick);
          resolve(false);
        });
      })
  );
}

/**
 * Same guided experience as the Swift recorder, driven by ffmpeg. The
 * capture backend is chosen by trying it: on Linux a PipeWire desktop
 * without pulseaudio-utils still answers to "-f pulse", and probing beats
 * guessing from which helper binaries happen to be installed.
 */
async function recordPortable(outFile: string): Promise<{ ok: boolean; error: string }> {
  let inputs: string[][];
  if (process.platform === "win32") {
    const device = await chooseWindowsInput();
    if (!device) {
      return { ok: false, error: "no DirectShow audio input was offered by ffmpeg" };
    }
    inputs = [["-f", "dshow", "-i", `audio=${device}`]];
  } else if (process.platform === "darwin") {
    inputs = [["-f", "avfoundation", "-i", ":default"]];
  } else {
    inputs = linuxCaptureInputs();
  }
  let last = { ok: false, error: "no capture backend worked" };
  for (const input of inputs) {
    last = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Claude Code TTS: recording - read the passage aloud",
        cancellable: true, // Cancel = finish early and keep what was recorded
      },
      (progress, token) => {
        const rec = recordWithFfmpeg(outFile, MAX_SECONDS, input);
        let elapsed = 0;
        const tick = setInterval(() => {
          elapsed++;
          progress.report({ increment: 100 / MAX_SECONDS, message: `${elapsed}s (press Cancel to finish early)` });
        }, 1000);
        token.onCancellationRequested(() => rec.stop());
        return rec.finished.then((r) => {
          clearInterval(tick);
          return r;
        });
      }
    );
    if (last.ok) {
      return last;
    }
  }
  return last;
}

export async function cloneVoiceFlow(context: vscode.ExtensionContext): Promise<string | undefined> {
  // Check the machine can record BEFORE asking for consent: nobody should
  // agree to terms for a feature that then reports it is unavailable.
  const recorder = recorderKind();
  if (!recorder) {
    const pick = await offerCommand(
      process.platform === "darwin"
        ? "Claude Code TTS: recording needs Apple's CommandLineTools (one-time install) or ffmpeg."
        : `Claude Code TTS: recording from the microphone needs ffmpeg. Install it, or clone from an audio or video file you already have.${AFTER_INSTALL_HINT}`,
      process.platform === "darwin" ? "xcode-select --install" : packageInstallCommand("ffmpeg"),
      "Clone from a file instead"
    );
    if (pick) {
      // Through its command, not its function: the file flow imports the
      // helpers in this file, and importing it back would be a cycle. The
      // command saves and activates the profile itself, so there is nothing
      // left to return.
      await vscode.commands.executeCommand("claudeCodeTts.cloneVoiceFromFile");
    }
    return undefined;
  }
  if (!(await ensureProfileEngine(context))) {
    return undefined;
  }
  if (!(await ensureCloneConsent(context))) {
    return undefined;
  }

  const code = await pickCloneLanguage(context.globalStorageUri.fsPath);
  if (!code) {
    return undefined;
  }
  const passage = passageFor(code);

  const permissionNote =
    process.platform === "darwin"
      ? "macOS will ask for microphone permission on first use."
      : process.platform === "win32"
        ? "Windows may ask which app can use the microphone; allow it for VS Code."
        : "Your desktop may ask for microphone access; allow it for VS Code.";
  const go = await vscode.window.showInformationMessage(
    `Clone your voice: a short passage opens next; read it aloud at your natural pace, then press Cancel to finish (it stops on its own after 20 seconds). ${permissionNote} Everything stays on this machine.`,
    { modal: true },
    "Open passage & record"
  );
  if (go !== "Open passage & record") {
    return undefined;
  }

  const bin = recorder === "swift" ? await ensureMicRecorder(context) : undefined;
  if (recorder === "swift" && !bin) {
    return undefined;
  }

  // Keep the passage on screen while the progress notification records.
  const doc = await vscode.workspace.openTextDocument({
    content: `READ THIS ALOUD (recording starts now):\n\n${passage}\n`,
    language: "plaintext",
  });
  await vscode.window.showTextDocument(doc, { preview: true });

  const dir = qwen3VoicesDir(context.globalStorageUri.fsPath);
  const tmpWav = path.join(dir, `.recording-${Date.now()}.wav`);
  fs.mkdirSync(dir, { recursive: true });

  const result = bin ? { ok: await record(bin, tmpWav), error: "" } : await recordPortable(tmpWav);
  const size = fs.existsSync(tmpWav) ? fs.statSync(tmpWav).size : 0;
  if (!result.ok || size < 24000 * 2 * 3) {
    fs.rmSync(tmpWav, { force: true });
    const where =
      process.platform === "darwin"
        ? "System Settings > Privacy & Security > Microphone"
        : process.platform === "win32"
          ? "Settings > Privacy & security > Microphone"
          : "your desktop's sound settings (input device)";
    vscode.window.showErrorMessage(
      `Claude Code TTS: recording too short or failed${result.error ? ` (${result.error})` : ""}. Check that VS Code may use the microphone in ${where}, then try again.`
    );
    return undefined;
  }
  const { seconds, rms } = trimSilence(tmpWav);
  if (seconds >= 3 && rms >= 200) {
    normalizeReference(tmpWav);
  }
  if (seconds < 3 || rms < 200) {
    fs.rmSync(tmpWav, { force: true });
    vscode.window.showErrorMessage(
      seconds < 3
        ? "Claude Code TTS: less than 3 seconds of speech was captured. Read the whole passage and try again."
        : "Claude Code TTS: the recording is very quiet. Move closer to the microphone, or pick a different input device in your system's sound settings, and try again."
    );
    return undefined;
  }

  // The cloner wants the transcript of what was actually said. Readers
  // stumble and skip words, so prefer Whisper's transcript when it is
  // plausible (mostly the passage) and fall back to the passage otherwise.
  let refText = passage;
  const heard = await transcribeRecording(context, tmpWav, code);
  let usedTranscript = false;
  if (heard) {
    const overlap = wordOverlap(heard, passage);
    // The transcript describes the audio far better than the passage when
    // the reader stumbled or got cut off; use it whenever it is substantial.
    if (heard.split(/\s+/).length >= 6 && overlap >= 0.3) {
      refText = heard;
      usedTranscript = true;
    }
    if (overlap < 0.3) {
      const choice = await vscode.window.showWarningMessage(
        `Claude Code TTS: the recording does not sound like the passage (heard: "${heard.slice(0, 120)}..."). Clone quality depends on reading the passage. Record again?`,
        { modal: true },
        "Record again",
        "Use anyway"
      );
      if (choice !== "Use anyway") {
        fs.rmSync(tmpWav, { force: true });
        return choice === "Record again" ? cloneVoiceFlow(context) : undefined;
      }
    }
  }

  const name = await inputWithBack({
    prompt: "Name this voice profile",
    title: "Clone your voice: name",
    value: "My voice",
    validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
  });
  if (!name || name === BACK) {
    fs.rmSync(tmpWav, { force: true });
    return undefined;
  }
  return saveCloneProfile(dir, name, tmpWav, {
    refText,
    passage,
    language: code,
    transcript: heard ?? null,
    usedTranscript,
    // Where the reference text came from. Without this, a recording made
    // with the (optional) transcription check declined was labelled
    // as if it had been made before the check existed, which is neither true
    // nor useful: the reference is the passage the reader had on screen, and
    // that is exactly what they were asked to read.
    textSource: usedTranscript ? "transcript" : "passage",
    source: "microphone",
  });
}

/** Move a prepared reference WAV into a new profile directory; returns "clone:<slug>". */
export function saveCloneProfile(dir: string, name: string, wav: string, meta: Record<string, unknown>): string {
  const slug = newProfileSlug(dir, name);
  const profileDir = path.join(dir, slug);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.renameSync(wav, path.join(profileDir, "ref.wav"));
  fs.writeFileSync(
    path.join(profileDir, "meta.json"),
    JSON.stringify({ name: name.trim(), ...meta, createdAt: new Date().toISOString(), trimmed: true }, null, 2)
  );
  return `clone:${slug}`;
}
