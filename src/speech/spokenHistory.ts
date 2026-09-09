/**
 * What was said, so it can be said again.
 *
 * Claude's prose scrolls past while you are looking somewhere else, and the
 * two questions that follow are "say that again" and "what did I miss".
 * Both are answered from here: the last message as chunks (so repeating it
 * costs no synthesis decisions) and a short list of the ones before it,
 * kept across window reloads.
 *
 * It is the only thing this extension stores that is a record of what you
 * were told, which is why the reset command clears it and the privacy
 * document says so.
 */
import { runtime } from "../core/runtime";

/** How many messages are kept; older ones fall off the end. */
const HISTORY_MAX = 20;
const HISTORY_KEY = "claudeCodeTts.history";

export interface SpokenMessage {
  at: number;
  chunks: string[];
}

let messages: SpokenMessage[] = [];
let last: string[] = [];

/** Read back what the previous window session recorded. */
export function loadHistory(): void {
  messages = runtime.remembered<SpokenMessage[]>(HISTORY_KEY) ?? [];
  last = messages[0]?.chunks ?? []; // repeat works right after a reload too
}

/** Remember a message that was just spoken. */
export function recordMessage(chunks: string[]): void {
  if (chunks.length === 0) {
    return;
  }
  last = chunks;
  messages.unshift({ at: Date.now(), chunks });
  if (messages.length > HISTORY_MAX) {
    messages.pop();
  }
  void runtime.remember(HISTORY_KEY, messages); // fire and forget
}

/** The messages there are, newest first. */
export const spokenMessages = (): SpokenMessage[] => messages;

/** The chunks of the most recent message, for the repeat command. */
export const lastSpoken = (): string[] => last;

/** Forget everything, on request. */
export async function clearHistory(): Promise<void> {
  messages = [];
  last = [];
  await runtime.remember(HISTORY_KEY, undefined);
}
