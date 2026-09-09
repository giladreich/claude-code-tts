/**
 * A speaking rate per voice.
 *
 * Voices do not read at the same pace. A preset speaker that already talks
 * quickly is uncomfortable at the rate that suits a slow cloned voice, so a
 * single global number means retuning by hand every time you switch. The
 * rate you set while listening to a voice therefore belongs to that voice:
 * switch away and the next voice speaks at the default, switch back and it
 * is as you left it.
 *
 * `claudeCodeTts.rate` stays the default for any voice you have not tuned.
 *
 * Pure: no vscode, so the rule is testable on its own.
 */
/** Identifies a voice across engines, since the same name can exist in two. */
export function voiceRateKey(engine: string, voice: string): string {
  return `${engine}:${voice}`;
}

/** What this voice should speak at: its own rate, or the default. */
export function rateFor(
  defaultRate: number,
  rates: Record<string, number> | undefined,
  engine: string,
  voice: string
): number {
  const own = rates?.[voiceRateKey(engine, voice)];
  return typeof own === "number" && Number.isFinite(own) ? own : defaultRate;
}

/**
 * The map with this voice's rate recorded, or removed when it matches the
 * default: an entry that says nothing is worth nothing, and the settings
 * file stays readable.
 */
export function withVoiceRate(
  rates: Record<string, number> | undefined,
  engine: string,
  voice: string,
  rate: number,
  defaultRate: number
): Record<string, number> {
  const next = { ...(rates ?? {}) };
  const key = voiceRateKey(engine, voice);
  if (rate === defaultRate) {
    delete next[key];
  } else {
    next[key] = rate;
  }
  return next;
}
