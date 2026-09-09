/**
 * "Manage Voices": everything about designed and cloned voice profiles (both
 * Qwen3 and Chatterbox speak them) in one place - audition, use, rename,
 * delete, adjust loudness and pace, and refine a designed voice from a
 * plain-language request ("warmer, a bit slower, clearer"). Refinement
 * re-renders the reference with the VoiceDesign model; you hear the result
 * and choose to apply it to this voice or keep it as a new one. Recorded
 * voices reproduce the recording, so they take loudness/pace adjustments and
 * a re-record, not text instructions. All local.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ensureQwen3Runtime } from "../setup/setupFlows";
import { passageFor } from "../voices/passages";
import { playSample, render, voiceDesignModelCached } from "../voices/design";
import { BACK, inputWithBack, pickWithPreview } from "./prompts";
import {
  CloneProfile,
  findQwen3MlxPython,
  findQwen3Python,
  listQwen3Clones,
  listTrashedProfiles,
  QWEN3_LANGUAGE_BY_CODE,
  newProfileSlug,
  restoreProfile,
  trashProfile,
  qwen3VoicesDir,
  readProfileMeta,
  updateProfileMeta,
} from "../tts/qwen3";
import { languageName } from "../language/language";
import { normalizeReference, trimSilence } from "../tts/wav";

interface Adjust {
  gainFactor?: number;
  paceFactor?: number;
  /** What remains of the request after loudness/pace words are taken out. */
  rest: string;
  notes: string[];
}

/**
 * Loudness and pace are not things a voice model understands ("louder"
 * describes the recording level); they are handled as profile settings and
 * removed from the description sent to the model. "A bit"/"much" scale the
 * step.
 */
export function parseAdjustments(request: string): Adjust {
  const r = request.toLowerCase();
  const small = /\b(a bit|a little|slightly|somewhat|touch)\b/.test(r);
  const big = /\b(much|a lot|way|far|significantly)\b/.test(r);
  const step = small ? 0.1 : big ? 0.3 : 0.2;
  const out: Adjust = { rest: request, notes: [] };
  const strip = (re: RegExp) =>
    (out.rest = out.rest
      .replace(re, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,.;]+|[\s,.;]+$/g, ""));
  if (/\b(louder|more volume|turn (it )?up|higher volume)\b/.test(r)) {
    out.gainFactor = 1 + step;
    out.notes.push(`loudness +${Math.round(step * 100)}%`);
    strip(
      /\b((a bit|a little|slightly|somewhat|much|a lot|way)\s+)?(louder|more volume|turn (it )?up|higher volume)\b/gi
    );
  } else if (/\b(quieter|softer volume|less volume|turn (it )?down|lower volume|too loud)\b/.test(r)) {
    out.gainFactor = 1 - step;
    out.notes.push(`loudness -${Math.round(step * 100)}%`);
    strip(
      /\b((a bit|a little|slightly|somewhat|much|a lot|way)\s+)?(quieter|softer volume|less volume|turn (it )?down|lower volume|too loud)\b/gi
    );
  }
  if (/\b(faster|quicker|speed (it )?up|more quickly|too slow)\b/.test(r)) {
    out.paceFactor = 1 + step;
    out.notes.push(`pace +${Math.round(step * 100)}%`);
    strip(
      /\b((a bit|a little|slightly|somewhat|much|a lot|way)\s+)?(faster|quicker|speed (it )?up|more quickly|too slow)\b/gi
    );
  } else if (/\b(slower|slow (it )?down|more slowly|too fast)\b/.test(r)) {
    out.paceFactor = 1 - step;
    out.notes.push(`pace -${Math.round(step * 100)}%`);
    strip(/\b((a bit|a little|slightly|somewhat|much|a lot|way)\s+)?(slower|slow (it )?down|more slowly|too fast)\b/gi);
  }
  strip(/\b(and|please|make (the|it|this) voice|make it|the voice|voice)\b/gi);
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function describe(p: CloneProfile): string {
  const bits: string[] = [];
  bits.push(`${p.designed ? "designed" : "recorded"}, ${languageName(p.language ?? "en")}`);
  if (p.gain !== 1) {
    bits.push(`loudness ${p.gain > 1 ? "+" : ""}${Math.round((p.gain - 1) * 100)}%`);
  }
  if (p.pace !== 1) {
    bits.push(`pace ${p.pace > 1 ? "+" : ""}${Math.round((p.pace - 1) * 100)}%`);
  }
  if (p.designed && p.description) {
    bits.push(p.description.slice(0, 60));
  } else {
    bits.push(`${Math.round(p.refSeconds)}s reference`);
  }
  return bits.join(" - ");
}

export interface VoiceManagerDeps {
  context: vscode.ExtensionContext;
  currentVoice: () => string;
  /** Voice to fall back to when the one in use is deleted (engine-specific:
   *  Chatterbox has no presets, so it must be another profile). */
  fallbackVoice?: () => string;
  volume: () => number;
  /** Activate a profile (updates settings; the engine switches). */
  useVoice: (value: string) => Promise<void>;
  /** The active engine rebuilds its profile data (gain/pace/reference changed). */
  refreshEngine: () => void;
}

export async function manageVoicesFlow(deps: VoiceManagerDeps, back = false): Promise<"back" | "closed"> {
  const dir = qwen3VoicesDir(deps.context.globalStorageUri.fsPath);
  for (;;) {
    const profiles = listQwen3Clones(dir);
    const DESIGN = "$(wand) Design a new voice...";
    const RECORD = "$(mic) Record & clone my voice...";
    const FILE = "$(file-media) Clone my voice from an audio file...";
    const GUIDANCE = "$(law) Responsible use of voice cloning...";
    const BACKUP = "$(save) Back up / import voices...";
    const RESTORE = "$(history) Restore a deleted voice...";
    const items: (vscode.QuickPickItem & { profile?: CloneProfile })[] = [
      ...profiles.map((p) => ({
        label: `${p.designed ? "$(wand)" : "$(person)"} ${p.name}`,
        description: `clone:${p.slug}` === deps.currentVoice() ? "current" : "",
        detail: describe(p),
        profile: p,
      })),
      { label: DESIGN, detail: "Describe a voice in words; a profile is rendered locally" },
      { label: RECORD, detail: "Read a short passage; a profile of your voice is created locally" },
      { label: FILE, detail: "Use a recording you already have (any common format)" },
      {
        label: BACKUP,
        detail: "Write your voices to a file, or install voices from one (they cannot be downloaded again)",
      },
      ...(listTrashedProfiles(dir).length > 0
        ? [{ label: RESTORE, detail: `${listTrashedProfiles(dir).length} deleted voice(s) can still be restored` }]
        : []),
      { label: GUIDANCE, detail: "Consent, impersonation, disclosure: what cloning may and may not be used for" },
    ];
    // Highlighting a voice plays its reference, the way every other voice
    // picker in the extension behaves. Hearing them used to take three
    // interactions: select a voice, choose "Hear the reference", then close
    // the modal that held the sample.
    const picked = await pickWithPreview({
      items,
      placeholder: profiles.length
        ? "Highlight a voice to hear it, Enter to manage it"
        : "No voices yet. Design or record one.",
      title: "My voices (they speak through Qwen3 and Chatterbox)",
      back,
      preview: (item) => (item.profile ? playSample(item.profile.refWav, deps.volume()) : undefined),
    });
    if (picked === "back") {
      return "back";
    }
    if (!picked) {
      return "closed";
    }
    if (picked.label === DESIGN) {
      await vscode.commands.executeCommand("claudeCodeTts.designVoice", true);
      continue; // the list comes back with the new voice in it
    }
    if (picked.label === RECORD) {
      await vscode.commands.executeCommand("claudeCodeTts.cloneVoice", true);
      continue;
    }
    if (picked.label === FILE) {
      await vscode.commands.executeCommand("claudeCodeTts.cloneVoiceFromFile", true);
      continue;
    }
    if (picked.label === RESTORE) {
      const trashed = listTrashedProfiles(dir);
      const which = await pickWithPreview({
        items: trashed.map((t) => ({
          label: t.name,
          description: t.deletedAt ? `deleted ${t.deletedAt}` : "",
          entry: t.entry,
        })),
        placeholder: "Restore which voice?",
        title: "Deleted voices",
        back: true,
        preview: () => undefined,
      });
      if (which && which !== "back") {
        const slug = restoreProfile(dir, which.entry);
        const use = await vscode.window.showInformationMessage(
          `Claude Code TTS: "${which.label}" restored.`,
          "Use it",
          "Later"
        );
        if (use === "Use it") {
          await deps.useVoice(`clone:${slug}`);
        }
      }
      continue;
    }
    if (picked.label === BACKUP) {
      const what = await pickWithPreview({
        items: [{ label: "Back up my voices to a file" }, { label: "Import voices from a file" }],
        placeholder: "Voice backups",
        title: "Back up / import",
        back: true,
        preview: () => undefined,
      });
      if (what !== "back" && what?.label.startsWith("Back up")) {
        await vscode.commands.executeCommand("claudeCodeTts.exportVoices", true);
      } else if (what !== "back" && what) {
        await vscode.commands.executeCommand("claudeCodeTts.importVoices", true);
      }
      continue;
    }
    if (picked.label === GUIDANCE) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(deps.context.extensionPath, "docs", "RESPONSIBLE-USE.md"))
      );
      await vscode.window.showTextDocument(doc, { preview: true });
      continue;
    }
    const again = await manageOne(deps, dir, picked.profile!);
    if (!again) {
      return "closed";
    }
  }
}

/** Returns true to go back to the list. */
async function manageOne(deps: VoiceManagerDeps, dir: string, p: CloneProfile): Promise<boolean> {
  const profileDir = path.join(dir, p.slug);
  const isCurrent = `clone:${p.slug}` === deps.currentVoice();
  const actions: { label: string; detail?: string; run: () => Promise<boolean | void> }[] = [
    {
      label: "$(play) Hear the reference again",
      detail: p.designed ? "The rendered reference reading" : "Your recording (trimmed)",
      run: async () => {
        const s = playSample(p.refWav, deps.volume());
        await vscode.window.showInformationMessage(
          `Playing "${p.name}" (${Math.round(p.refSeconds)}s).`,
          { modal: true },
          "Stop"
        );
        s.stop();
        return true;
      },
    },
    ...(isCurrent
      ? []
      : [
          {
            label: "$(check) Use this voice",
            detail: "Becomes the voice of the engine you are on (Qwen3 or Chatterbox)",
            run: async () => void (await deps.useVoice(`clone:${p.slug}`)),
          },
        ]),
    {
      label: "$(comment) Refine with a request...",
      detail: p.designed
        ? "e.g. warmer, a bit louder, slower, clearer pronunciation; you hear the result before applying"
        : "Recorded voices take loudness/pace changes; the timbre is your recording (re-record to change it)",
      run: () => refine(deps, dir, p),
    },
    {
      label: "$(unmute) Loudness...",
      detail: `Now ${Math.round(p.gain * 100)}%`,
      run: () => adjustNumber(deps, profileDir, "gain", p.gain, 50, 200, "%"),
    },
    {
      label: "$(dashboard) Pace...",
      detail: `Now ${Math.round(p.pace * 100)}%`,
      run: () => adjustNumber(deps, profileDir, "pace", p.pace, 70, 140, "%"),
    },
    ...(p.designed
      ? []
      : [
          {
            label: "$(book) Reference text...",
            detail:
              "The words in the recording, as the cloner reads them along with it; a wrong word here is heard in every sentence",
            run: async () => {
              const text = await inputWithBack(
                {
                  prompt:
                    "Exactly what is said in the reference recording, corrected where the transcription got a word wrong",
                  title: `Reference text of "${p.name}"`,
                  value: p.refText,
                  validateInput: (v) => (v.trim().split(/\s+/).length >= 4 ? undefined : "At least a few words"),
                },
                true
              );
              if (text && text !== BACK && text.trim() !== p.refText) {
                updateProfileMeta(profileDir, { refText: text.trim(), transcript: text.trim(), textSource: "typed" });
                deps.refreshEngine();
                vscode.window.setStatusBarMessage("Claude Code TTS: reference text updated", 3000);
              }
              return true;
            },
          },
        ]),
    {
      label: "$(edit) Rename...",
      run: async () => {
        const name = await inputWithBack(
          {
            prompt: "New name",
            title: `Rename "${p.name}"`,
            value: p.name,
            validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
          },
          true
        );
        if (name && name !== BACK) {
          updateProfileMeta(profileDir, { name: name.trim() });
        }
        return true;
      },
    },
    {
      label: "$(trash) Delete",
      run: async () => {
        const ok = await vscode.window.showWarningMessage(
          `Delete the voice "${p.name}"? A voice cannot be downloaded again, so it is moved to the trash and can be restored from "Manage Voices" until you empty it in "Storage and Cleanup".`,
          { modal: true },
          "Delete"
        );
        if (ok !== "Delete") {
          return true;
        }
        trashProfile(dir, p.slug);
        if (isCurrent) {
          await deps.useVoice(deps.fallbackVoice ? deps.fallbackVoice() : "Ryan");
        }
        return true;
      },
    },
  ];
  const picked = await pickWithPreview({
    items: actions,
    placeholder: describe(p),
    title: p.name,
    back: true,
    preview: () => undefined,
  });
  // Back to the list of voices
  if (!picked || picked === "back") {
    return true;
  }
  const r = await picked.run();
  return r !== false;
}

async function adjustNumber(
  deps: VoiceManagerDeps,
  profileDir: string,
  field: "gain" | "pace",
  current: number,
  lo: number,
  hi: number,
  unit: string
): Promise<boolean> {
  const v = await inputWithBack(
    {
      prompt: `${field === "gain" ? "Loudness" : "Pace"} in percent (${lo}-${hi}; 100 = as generated)`,
      title: field === "gain" ? "Loudness" : "Pace",
      value: String(Math.round(current * 100)),
      validateInput: (s) =>
        /^\d+$/.test(s) && +s >= lo && +s <= hi ? undefined : `Enter a number between ${lo} and ${hi}`,
    },
    true
  );
  if (!v || v === BACK) {
    return true;
  }
  updateProfileMeta(profileDir, { [field]: +v / 100 });
  deps.refreshEngine();
  vscode.window.setStatusBarMessage(
    `Claude Code TTS: ${field === "gain" ? "loudness" : "pace"} set to ${v}${unit}`,
    3000
  );
  return true;
}

/** Refine from a request; returns true to return to the list. */
async function refine(deps: VoiceManagerDeps, dir: string, p: CloneProfile): Promise<boolean> {
  const profileDir = path.join(dir, p.slug);
  const request = await inputWithBack(
    {
      prompt: p.designed
        ? 'What should change? (e.g. "warmer and a bit slower", "clearer pronunciation", "a little louder")'
        : "What should change? Loudness and pace are applied; other wording needs a re-record.",
      title: `Refine "${p.name}"`,
      placeHolder: "a bit louder, more natural, slower",
      validateInput: (v) => (v.trim().length >= 3 ? undefined : "Say what should change"),
    },
    true
  );
  if (!request || request === BACK) {
    return true;
  }
  const adj = parseAdjustments(request);
  const newGain = clamp(p.gain * (adj.gainFactor ?? 1), 0.5, 2);
  const newPace = clamp(p.pace * (adj.paceFactor ?? 1), 0.7, 1.4);

  if (!p.designed || !adj.rest) {
    // Settings-only change (or a recorded voice): apply immediately.
    if (adj.notes.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        p.designed
          ? "Nothing to change: describe the voice quality (warmer, clearer, ...) or loudness/pace."
          : `"${p.name}" is a recording, so its timbre cannot be changed by description. Loudness and pace can (say "louder" or "slower"), or re-record it.`,
        "Re-record",
        "OK"
      );
      if (choice === "Re-record") {
        await vscode.commands.executeCommand("claudeCodeTts.cloneVoice", true);
      }
      return true;
    }
    updateProfileMeta(profileDir, { gain: newGain, pace: newPace });
    deps.refreshEngine();
    vscode.window.showInformationMessage(`Claude Code TTS: applied to "${p.name}": ${adj.notes.join(", ")}.`);
    return true;
  }

  // Designed voice: re-render the reference with the amended description.
  if (!(await ensureQwen3Runtime("Refining a designed voice"))) {
    return true;
  }
  const python = findQwen3MlxPython() ?? findQwen3Python();
  const script = path.join(deps.context.extensionPath, "assets", "qwen3_design.py");
  if (!python || !fs.existsSync(script)) {
    vscode.window.showWarningMessage(
      "Claude Code TTS: Qwen3-TTS installed but could not be found afterwards (see the log)."
    );
    return true;
  }
  // Refine in the language the voice was built in, so its accent is kept.
  const code = p.language ?? "en";
  const language = QWEN3_LANGUAGE_BY_CODE[code] ?? "English";
  const passage = passageFor(code);
  const description = `${p.description ?? ""}. ${adj.rest.charAt(0).toUpperCase()}${adj.rest.slice(1)}.`
    .replace(/\.\s*\./g, ".")
    .trim();
  const logFile = path.join(deps.context.globalStorageUri.fsPath, "qwen3-design.log");
  for (;;) {
    const tmpWav = path.join(dir, `.refine-${Date.now()}.wav`);
    const result = await render(
      python,
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
      if (result.error !== "cancelled") {
        vscode.window.showErrorMessage(`Claude Code TTS: refining failed: ${result.error ?? "unknown error"}`);
      }
      return true;
    }
    const { seconds } = trimSilence(tmpWav);
    if (seconds < 4) {
      fs.rmSync(tmpWav, { force: true });
      vscode.window.showErrorMessage(
        "Claude Code TTS: the model produced almost no speech for that description; try different wording."
      );
      return true;
    }
    normalizeReference(tmpWav);
    const sample = playSample(tmpWav, deps.volume() * newGain);
    const extra = adj.notes.length ? ` Also: ${adj.notes.join(", ")}.` : "";
    const choice = await vscode.window.showInformationMessage(
      `This is "${p.name}" refined: "${description}".${extra} What do you want to do?`,
      { modal: true },
      "Apply to this voice",
      "Save as a new voice",
      "Try again"
    );
    sample.stop();
    if (choice === "Try again") {
      fs.rmSync(tmpWav, { force: true });
      continue;
    }
    if (choice === "Apply to this voice") {
      const backup = path.join(profileDir, "ref.previous.wav");
      fs.copyFileSync(p.refWav, backup); // one step of undo by hand
      fs.renameSync(tmpWav, p.refWav);
      updateProfileMeta(profileDir, {
        description,
        refText: passage,
        language: code,
        gain: newGain,
        pace: newPace,
        refinedAt: new Date().toISOString(),
      });
      deps.refreshEngine();
      vscode.window.showInformationMessage(
        `Claude Code TTS: "${p.name}" updated (previous reference kept as ref.previous.wav).`
      );
      return true;
    }
    if (choice === "Save as a new voice") {
      const name = await inputWithBack(
        {
          prompt: "Name the new voice",
          title: "Save as a new voice",
          value: `${p.name} 2`,
          validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
        },
        true
      );
      if (!name || name === BACK) {
        fs.rmSync(tmpWav, { force: true });
        return true;
      }
      const slug = newProfileSlug(dir, name);
      const newDir = path.join(dir, slug);
      fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(tmpWav, path.join(newDir, "ref.wav"));
      const meta = readProfileMeta(profileDir);
      fs.writeFileSync(
        path.join(newDir, "meta.json"),
        JSON.stringify(
          {
            ...meta,
            name: name.trim(),
            description,
            refText: passage,
            language: code,
            usedTranscript: true,
            designed: true,
            gain: newGain,
            pace: newPace,
            createdAt: new Date().toISOString(),
            trimmed: true,
            derivedFrom: p.slug,
          },
          null,
          2
        )
      );
      const use = await vscode.window.showInformationMessage(
        `Claude Code TTS: saved "${name.trim()}". Use it now?`,
        "Use it",
        "Later"
      );
      if (use === "Use it") {
        await deps.useVoice(`clone:${slug}`);
      }
      return true;
    }
    fs.rmSync(tmpWav, { force: true });
    return true;
  }
}
