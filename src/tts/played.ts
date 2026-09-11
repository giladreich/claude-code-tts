/**
 * What the speakers produced, reported once per finished utterance so that
 * it can be kept and exported to a file later.
 *
 * The engines are the only place that knows what was actually heard: the
 * text after translation and coalescing, the voice that spoke it, the speed
 * the player applied, and the files the audio came from. They hand all of it
 * here rather than deleting the audio, and whoever listens (the played-audio
 * buffer) decides whether to keep it. Nothing listening means the engines
 * behave exactly as before: the files are deleted after playback.
 */
export interface PlayedUtterance {
  /** The text as it was synthesized: translated, substituted, coalesced. */
  text: string;
  engine: string;
  voice: string;
  /** The rate that was asked for, words per minute. */
  wpm: number;
  language?: string;
  /** The message this belongs to, as the queue was told (see speaking.ts). */
  group?: string;
  /** The playback tempo the player applied; 1 when the audio was played as it was. */
  tempo: number;
  /** The speed the engine baked into the audio itself; 1 at its natural pace. */
  synthSpeed: number;
  startedAt: number;
  endedAt: number;
  /** The audio files, in playback order, for engines that produce them. */
  parts?: string[];
  /**
   * For engines that speak without a file: renders the same utterance, with
   * the same voice and rate, into the WAV named. Rendering is deferred so the
   * speaking path pays nothing for it.
   */
  render?: (outWav: string) => Promise<void>;
}

/** Answers true when it took the files, so the reporter must not delete them. */
type PlayedSink = (utterance: PlayedUtterance) => boolean;

let sink: PlayedSink | undefined;

export function setPlayedSink(fn: PlayedSink | undefined): void {
  sink = fn;
}

/** Report a finished utterance; true when the audio files now belong to the sink. */
export function reportPlayed(utterance: PlayedUtterance): boolean {
  if (!sink) {
    return false;
  }
  try {
    return sink(utterance) === true;
  } catch {
    return false;
  }
}
