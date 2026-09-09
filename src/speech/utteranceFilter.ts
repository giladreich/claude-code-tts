/**
 * What actually gets said, out of what a transcript line offers.
 *
 * Two settings and one piece of state decide this, and the whole decision
 * used to live inside the tailer callback in activate(): a closure no test
 * could reach, in the file that also holds every command handler. It is the
 * part of the extension a listener notices most (a tool announced over and
 * over, an ignored tool that still speaks), so it belongs somewhere it can
 * be tested.
 *
 * Pure: no vscode, no timers, no I/O. The clock is a parameter.
 */
import { Utterance } from "./format";

export interface SpeakFilters {
  ignoredTools: string[];
  /**
   * An unchanged tool announcement is silent until the activity has been
   * running this long, then it is repeated as "Still ...". 0 turns the
   * reminder off entirely.
   */
  collapseToolSeconds: number;
}

/** Carried between lines: the last announcement, and when it was made. */
export interface ToolStreak {
  text: string;
  at: number;
}

export function newToolStreak(): ToolStreak {
  return { text: "", at: 0 };
}

/**
 * The utterances to speak, in order, with the tool-repeat rule applied.
 * `streak` is updated in place, because it spans lines.
 */
export function filterUtterances(
  utterances: Utterance[],
  filters: SpeakFilters,
  streak: ToolStreak,
  now: number
): Utterance[] {
  const out: Utterance[] = [];
  for (const u of utterances) {
    if (u.kind === "tool") {
      if (u.tool && filters.ignoredTools.includes(u.tool)) {
        continue;
      }
      if (u.text === streak.text) {
        // The same activity, still going: silence carries the same
        // information and costs nothing, but a task that runs for minutes
        // should not sound like the extension died.
        const remindDue = filters.collapseToolSeconds > 0 && now - streak.at >= filters.collapseToolSeconds * 1000;
        if (!remindDue) {
          continue;
        }
        streak.at = now;
        out.push({ ...u, text: `Still ${u.text.charAt(0).toLowerCase()}${u.text.slice(1)}` });
        continue;
      }
      streak.text = u.text;
      streak.at = now;
    } else if (u.kind === "text") {
      // Prose in between ends the streak: the same action afterwards is a
      // new step of the task, and worth announcing again.
      streak.text = "";
      streak.at = 0;
    }
    out.push(u);
  }
  return out;
}
