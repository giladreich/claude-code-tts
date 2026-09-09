/**
 * What the voice designer is told to sound like, per language.
 *
 * The designer renders only Qwen3's ten languages, so a voice meant for one of
 * the others is rendered on an English passage. That makes the DESCRIPTION the
 * only thing carrying the accent, and a language without its own entry here
 * used to fall back to the English wording: asking for a voice in another
 * language produced
 * "a warm American woman speaking her native English", and it sounded like it.
 * Every language a voice can be designed for has an entry.
 */
export interface Starter {
  label: string;
  detail: string;
  instruct: string;
}

/**
 * Starters per language. The description tells the model what kind of voice
 * to be; the passage it reads (in that language) is what fixes the accent.
 */
export const NATIVE: Record<string, { woman: string; man: string; adjective: string }> = {
  en: { woman: "American woman", man: "American man", adjective: "English" },
  de: { woman: "German woman", man: "German man", adjective: "German" },
  fr: { woman: "French woman", man: "French man", adjective: "French" },
  es: { woman: "Spanish woman", man: "Spanish man", adjective: "Spanish" },
  it: { woman: "Italian woman", man: "Italian man", adjective: "Italian" },
  pt: { woman: "Portuguese woman", man: "Portuguese man", adjective: "Portuguese" },
  ja: { woman: "Japanese woman", man: "Japanese man", adjective: "Japanese" },
  zh: { woman: "Chinese woman", man: "Chinese man", adjective: "Chinese" },
  ko: { woman: "Korean woman", man: "Korean man", adjective: "Korean" },
  ru: { woman: "Russian woman", man: "Russian man", adjective: "Russian" },
  // Languages the designer cannot read. It renders an English passage, so the
  // description is what carries the accent: "an Israeli woman" produces a
  // Hebrew-sounding voice where "an American woman" produced an American one.
  he: { woman: "Israeli woman", man: "Israeli man", adjective: "Hebrew" },
  ar: { woman: "Arabic-speaking woman", man: "Arabic-speaking man", adjective: "Arabic" },
  tr: { woman: "Turkish woman", man: "Turkish man", adjective: "Turkish" },
  el: { woman: "Greek woman", man: "Greek man", adjective: "Greek" },
  hi: { woman: "Indian woman", man: "Indian man", adjective: "Hindi" },
  nl: { woman: "Dutch woman", man: "Dutch man", adjective: "Dutch" },
  pl: { woman: "Polish woman", man: "Polish man", adjective: "Polish" },
  sv: { woman: "Swedish woman", man: "Swedish man", adjective: "Swedish" },
  da: { woman: "Danish woman", man: "Danish man", adjective: "Danish" },
  fi: { woman: "Finnish woman", man: "Finnish man", adjective: "Finnish" },
  no: { woman: "Norwegian woman", man: "Norwegian man", adjective: "Norwegian" },
  ms: { woman: "Malay woman", man: "Malay man", adjective: "Malay" },
  sw: { woman: "Swahili-speaking woman", man: "Swahili-speaking man", adjective: "Swahili" },
};

export function startersFor(code: string): Starter[] {
  const n = NATIVE[code] ?? NATIVE.en;
  return [
    {
      label: `Warm ${n.woman}`,
      detail: `Friendly, calm, native ${n.adjective}, relaxed pace`,
      instruct: `A warm, friendly young ${n.woman} speaking her native ${n.adjective} calmly and naturally at a relaxed pace.`,
    },
    {
      label: `Professional ${n.woman}`,
      detail: "Articulate, confident, calm",
      instruct: `A confident ${n.woman} in her thirties with a clear, articulate voice and a calm, professional tone, speaking native ${n.adjective}.`,
    },
    {
      label: `Calm ${n.man}`,
      detail: "Deep, steady, documentary style",
      instruct: `A calm ${n.man} with a deep, steady voice speaking native ${n.adjective}, like a documentary voice-over.`,
    },
    {
      label: `Bright, energetic ${n.woman}`,
      detail: "Upbeat and expressive, light and quick",
      instruct: `A bright, energetic young ${n.woman} speaking native ${n.adjective}, upbeat and expressive but natural, a little quickly.`,
    },
    {
      label: `Soft-spoken ${n.woman}`,
      detail: "Gentle, low-key, soothing narration",
      instruct: `A gentle, soft-spoken ${n.woman} with a soothing low voice, narrating calmly and clearly in native ${n.adjective}.`,
    },
    {
      label: `Friendly ${n.man}`,
      detail: "Warm, articulate, conversational",
      instruct: `A friendly ${n.man} in his forties with a warm, articulate, conversational voice, speaking native ${n.adjective}.`,
    },
  ];
}
