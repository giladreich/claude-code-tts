/**
 * What this machine can say, and how to give it more.
 *
 * The facts every language flow starts from: which languages the installed
 * voices cover, which system voice speaks one, how to fetch a voice for a
 * language that has none, and a sentence in each language so an audition
 * says something. No flow lives here; these are the answers flows are built
 * from.
 */
import * as vscode from "vscode";
import { config } from "../core/config";
import { InstalledVoiceLanguages, languageName, LanguageVoiceChoice, voiceChangeForLanguage } from "./language";
import { runtime } from "../core/runtime";
import { ensurePiper } from "../setup/setupFlows";
import { chatterboxReady } from "../tts/chatterbox";
import { CURATED_VOICES, curatedVoicesFor, listPiperVoices, piperVoiceLanguage, piperVoicesDir } from "../tts/piper";
import { fetchCuratedVoice } from "../setup/piperSetup";
import { listQwen3Clones, qwen3VoicesDir, resolveQwen3Runtime } from "../tts/qwen3";
import { listSystemVoices } from "../tts/system";

/** Languages the installed system and Piper voices cover; cached per session. */
export async function voiceLanguages(): Promise<InstalledVoiceLanguages> {
  // Readiness of Chatterbox changes within a session (setup, a first voice)
  // and is cheap to compute, so it is not part of the cached map.
  const chatterbox =
    chatterboxReady(runtime.context.globalStorageUri.fsPath) &&
    listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath)).length > 0;
  const qwen3 = resolveQwen3Runtime(config().speechConfig.qwen3Runtime) !== undefined;
  if (installedLanguages) {
    return { ...installedLanguages, chatterbox, qwen3 };
  }
  const system = [...new Set((await listSystemVoices()).map((v) => v.language).filter((c): c is string => !!c))];
  const piper = [
    ...new Set(
      listPiperVoices(piperVoicesDir(runtime.context.globalStorageUri.fsPath))
        .map((v) => piperVoiceLanguage(v.name))
        .filter((c): c is string => !!c)
    ),
  ];
  const piperDownloadable = [...new Set(CURATED_VOICES.map((v) => v.id.slice(0, 2).toLowerCase()))];
  installedLanguages = { system, piper, piperDownloadable };
  return { ...installedLanguages, chatterbox, qwen3 };
}

/** A system voice that speaks this language, for suggesting one by name. */
export async function systemVoiceFor(code: string): Promise<string | undefined> {
  return (await listSystemVoices()).find((v) => v.language === code)?.name;
}

/**
 * The voice change that makes a language audible on this setup, or nothing
 * when the voice in use already says it. Gathers what is installed and hands
 * the decision to voiceChangeForLanguage.
 */
export async function voiceChoices(): Promise<(code: string) => LanguageVoiceChoice> {
  const cfg = config().speechConfig;
  // Gathered once: listing the system voices costs a process, and the list of
  // languages asks this question three dozen times.
  const systemVoices = cfg.engine === "system" ? await listSystemVoices() : [];
  const piperVoices = cfg.engine === "piper" ? listPiperVoices(piperVoicesDir(runtime.storagePath)) : [];
  return (code: string) =>
    voiceChangeForLanguage({
      code,
      engine: cfg.engine,
      currentVoice: cfg.voice,
      systemVoices,
      piperVoices,
      piperLanguage: piperVoiceLanguage,
    });
}

/** The same answer for one language. */
export async function voiceForLanguage(code: string): Promise<LanguageVoiceChoice> {
  return (await voiceChoices())(code);
}

/**
 * Download the curated Piper voice for a language and make it the voice for
 * that language: a neural voice for languages the engine in use cannot say,
 * and the most accurate option measured here for a few of them. Several of
 * those languages are also spoken by Chatterbox in a voice of the user's
 * own, which is what the pickers suggest first.
 */
export async function downloadVoiceForLanguage(code: string): Promise<boolean> {
  const candidates = curatedVoicesFor(code);
  if (candidates.length === 0) {
    return false;
  }
  if (!(await ensurePiper())) {
    return false;
  }
  const voice = candidates[0];
  // Already downloaded: no question to ask, only the mapping to make.
  const already = listPiperVoices(piperVoicesDir(runtime.context.globalStorageUri.fsPath)).find(
    (v) => v.name === voice.id
  )?.modelPath;
  if (!already) {
    const go = await vscode.window.showInformationMessage(
      `Download the ${languageName(code)} voice ${voice.id} (${voice.mb} MB, once)? ${voice.detail}. Licence: ${voice.license}.`,
      { modal: true },
      "Download"
    );
    if (go !== "Download") {
      return false;
    }
  }
  const modelPath = already ?? (await fetchCuratedVoice(runtime.context, voice));
  if (!modelPath) {
    return false;
  }
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  // The mapping carries its engine, so this voice is used for that language
  // whatever engine is otherwise active.
  await c.update(
    "languageVoices",
    { ...config().speechConfig.languageVoices, [code]: { engine: "piper", voice: modelPath } },
    vscode.ConfigurationTarget.Global
  );
  await c.update("piper.voice", modelPath, vscode.ConfigurationTarget.Global);
  installedLanguages = undefined; // the capability map changed
  vscode.window.showInformationMessage(`Claude Code TTS: ${languageName(code)} will be spoken by ${voice.id}.`);
  return true;
}

/** A sentence in each language, so an audition is actually informative. */
export const SAMPLES: Record<string, string> = {
  en: "This voice will read English messages.",
  de: "Diese Stimme liest deutsche Nachrichten vor.",
  fr: "Cette voix lira les messages en français.",
  es: "Esta voz leera los mensajes en espanol.",
  it: "Questa voce leggera i messaggi in italiano.",
  pt: "Esta voz vai ler as mensagens em portugues.",
  nl: "Deze stem leest Nederlandse berichten voor.",
  ja: "この声で日本語のメッセージを読み上げます。",
  zh: "这个声音会朗读中文消息。",
  ko: "이 목소리로 한국어 메시지를 읽습니다.",
  ru: "Этот голос будет читать сообщения на русском.",
  hi: "यह आवाज़ हिंदी संदेश पढ़ेगी।",
  ar: "هذا الصوت سيقرأ الرسائل بالعربية.",
  he: "הַקּוֹל הַזֶּה יַקְרִיא הוֹדָעוֹת בְּעִבְרִית.",
  el: "Αυτή η φωνή θα διαβάζει μηνύματα στα ελληνικά.",
  th: "เสียงนี้จะอ่านข้อความภาษาไทย",
};
let installedLanguages: InstalledVoiceLanguages | undefined;
