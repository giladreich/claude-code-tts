import * as path from "path";
import { detectLanguage, isDenseScript } from "../language/language";

/**
 * Convert Claude's markdown prose into something worth hearing.
 * Code is dropped, not read: fenced blocks, indented blocks, tables.
 */
export function cleanTextForSpeech(md: string): string {
  // Nothing to pronounce at all (a lone arrow, "...", a rule of dashes).
  if (!/[\p{L}\p{N}]/u.test(md)) {
    return "";
  }
  let s = md;
  // Invisible format characters (the marks that bracket right-to-left
  // text, zero-width joiners) carry no speech and crash Piper's phonemizer.
  s = s.replace(/\p{Cf}/gu, "");
  // Typographic bullets are list markers like "-".
  s = s.replace(/^(\s*)[\u2022\u25aa\u25e6\u2023]\s+/gm, "$1- ");

  // Fenced code blocks (``` ... ```) are never spoken.
  s = s.replace(/```[\s\S]*?```/g, " ");
  // Unclosed trailing fence (block still streaming or malformed).
  s = s.replace(/```[\s\S]*$/g, " ");

  const lines = s.split("\n").filter((line) => {
    const t = line.trim();
    // Table rows
    if (t.startsWith("|")) {
      return false;
    }
    // Horizontal rules
    if (/^[-=_*]{3,}$/.test(t)) {
      return false;
    }
    // Indented code: require real code signals, not just parentheses, so
    // indented prose like "  4. Restart (optional)" is still spoken.
    if (
      /^ {4,}\S/.test(line) &&
      /[;{}]|=>|\(\)|^\s*(const|let|var|def|import|return|if|for|while|function|class|export)\b/.test(line)
    ) {
      return false;
    }
    return true;
  });
  // Headings and list items are read as sentences: without terminal
  // punctuation they run into the next line as one flat breath.
  const terminal = /[.!?:;,]$/;
  s = lines
    .map((line) => {
      const t = line.trim();
      if (!t) {
        return line;
      }
      if (/^#{1,6}\s+/.test(t) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || /^>\s?/.test(t)) {
        const body = t.replace(/[*_`]+$/, "");
        return terminal.test(body) ? line : `${line}.`;
      }
      return line;
    })
    .join("\n");

  // Images are dropped (alt text is not prose); links keep their label.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Bare URLs read terribly.
  s = s.replace(/https?:\/\/\S+/g, "link");
  // Inline code: keep the content, lose the backticks. Identifiers are read
  // as words: camelCase and snake_case are split (cleanTextForSpeech ->
  // "clean Text For Speech"), which every engine pronounces correctly.
  s = s.replace(/`([^`]*)`/g, (_m, code: string) =>
    code
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/_+/g, " ")
  );
  // Headings, blockquotes, list bullets.
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^>\s?/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  // Bold/italic markers.
  s = s.replace(/(\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1/g, "$2");
  // File paths sound better as their last segment, on either separator
  // ("C:\\Users\\me\\proj\\src\\extension.ts" reads as "extension.ts").
  s = s.replace(/(?:[A-Za-z]:)?(?:\\[\w.\-@]+){2,}/g, (m) => m.slice(m.lastIndexOf("\\") + 1));
  // A path is read as its last segment, but a slash between two ordinary
  // words is not a path: this pattern used to match the "/or" inside "and/or"
  // and the "/7" inside "24/7" and glue them into "andor" and "247", while a
  // bare relative path like "src/extension.ts" lost its leading segment the
  // same way and came out as "srcextension.ts". So the first segment is part
  // of the match now, and a path with no root counts as one only when it is
  // deep or ends in a file extension.
  s = s.replace(/(?:~|\.{1,2})?\/?(?:[\w.\-@]+\/)+[\w.\-@]+/g, (m) => {
    const rooted = /^[~/]/.test(m) || /^\.{1,2}\//.test(m);
    const segments = m.split("/").filter(Boolean);
    const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(segments[segments.length - 1] ?? "");
    return rooted || hasExtension || segments.length > 2 ? path.basename(m) : m;
  });

  // Arrows mean "to" in prose ("Select Voice -> Kokoro"); read as symbols
  // they are noise, and alone they are input no engine can voice.
  s = s
    .replace(/^\s*(?:(?:\u2192|\u21d2|\u21a6|->|=>)\s*)+/gm, "")
    .replace(/(?:\s*(?:\u2192|\u21d2|\u21a6|->|=>))+\s*$/gm, "");
  s = s.replace(/\s*(?:\u2192|\u21d2|\u21a6|->|=>)\s*/g, " to ");

  s = s
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ");
  s = s.replace(/\s([.,!?;:])/g, "$1");
  s = s.replace(/([.!?:;,])\.(?=\s|$)/g, "$1"); // "Title.." from a heading + paragraph join
  s = s.trim();
  // Nothing left to pronounce (a lone arrow, "...", a rule of dashes): say nothing.
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

/** Short spoken summary of a tool call, e.g. "Bash: install dependencies". */
export function describeTool(name: string, input: Record<string, unknown>): string | undefined {
  const str = (k: string): string => (typeof input[k] === "string" ? input[k] : "");
  const base = (p: string): string => (p ? path.basename(p) : "");

  switch (name) {
    case "Bash": {
      const desc = str("description");
      if (desc) {
        return `Bash: ${desc}`;
      }
      const cmd = str("command").split("\n")[0];
      return `Bash: ${cmd.split(/\s+/).slice(0, 6).join(" ")}`;
    }
    case "Read":
      return `Reading ${base(str("file_path"))}`;
    case "Write":
      return `Writing ${base(str("file_path"))}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Editing ${base(str("file_path") || str("notebook_path"))}`;
    case "Grep":
      return `Searching for ${str("pattern")}`;
    case "Glob":
      return `Finding files ${str("pattern")}`;
    case "Agent":
    case "Task":
      return `Launching agent: ${str("description")}`;
    case "WebSearch":
      return `Searching the web for ${str("query")}`;
    case "WebFetch":
      return "Fetching a web page";
    case "TodoWrite":
      return "Updating the task list";
    case "AskUserQuestion": {
      const qs = input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }> | undefined;
      const q = qs?.[0];
      if (q?.question) {
        const labels = (q.options ?? [])
          .map((o) => o.label)
          .filter(Boolean)
          .slice(0, 4)
          .join(", ");
        const more = qs!.length > 1 ? ` And ${qs!.length - 1} more question${qs!.length > 2 ? "s" : ""}.` : "";
        return `Claude asks: ${q.question}${labels ? ` Options: ${labels}.` : ""}${more}`;
      }
      return "Claude has a question for you";
    }
    case "ExitPlanMode":
      return "Plan ready for review";
    case "Skill":
      return `Using skill ${str("skill")}`;
    default:
      // MCP tools look like mcp__server__tool; unknown tools just get their name.
      return name
        .replace(/^mcp__/, "")
        .replace(/__/g, " ")
        .replace(/_/g, " ");
  }
}

/**
 * Prose split at its sentence ends.
 *
 * Sentences end differently across scripts: CJK full stops and their
 * full-width marks, and the right-to-left question mark, end a sentence too,
 * and CJK text has no space after them. An alphabetic sentence, in either
 * direction, ends where the mark is followed by whitespace or the end:
 * splitting at every period cut decimal numbers and version strings apart
 * ("0.45" was spoken as "zero. forty-five"). Hindi ends sentences with the
 * danda instead of a full stop, so without it a Hindi paragraph was one
 * unsplittable chunk.
 */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?\u061f\u0964\u0965])(?=\s|$)\s*|(?<=[\u3002\uff01\uff1f])\s*/).filter((s) => s.length > 0);
}

/** Longest opening part before we split at a clause boundary (chars). */
const FIRST_PART_MAX = 60;

/**
 * Split cleaned prose into sentence-grouped chunks. A number gives uniform
 * chunks of ~that size; an array ramps per chunk (last entry repeats), so a
 * message can start with a small chunk for fast first audio and grow for
 * prosody. Smaller utterances also make skip granular.
 */
export function chunkForSpeech(
  text: string,
  targetChars: number | number[] = 260,
  /** Split a long opening sentence at a clause so audio starts sooner. Only
   *  worth its prosody cost when nothing is playing yet. */
  fastStart = true
): string[] {
  // Nothing pronounceable, nothing to chunk (see cleanTextForSpeech).
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return [];
  }
  const targets = Array.isArray(targetChars) ? targetChars : [targetChars];
  const targetFor = (i: number) => targets[Math.min(i, targets.length - 1)];
  // Chinese, Japanese and Thai write without spaces and pack far more speech
  // into the same number of characters, so the same targets would produce
  // minute-long chunks.
  const dense = isDenseScript(detectLanguage(text));
  const scale = dense ? 0.45 : 1;
  const targetAt = (i: number) => Math.round(targetFor(i) * scale);
  if (text.length <= targetAt(0) && (!fastStart || text.length <= FIRST_PART_MAX * scale)) {
    return [text];
  }
  let sentences = splitSentences(text);
  // Time-to-first-audio is bounded by the first sentence's synthesis time.
  // A long opening sentence is split once at a clause boundary so the first
  // part is short; the rest keeps normal sentence grouping.
  const chunks: string[] = [];
  if (fastStart && sentences[0].length > FIRST_PART_MAX * scale) {
    // Prefer the last clause boundary within the budget (short opener, fast
    // first audio); otherwise the first one after it, if not absurdly late.
    const first = sentences[0];
    let cut = -1;
    const re = /[,;:\uff0c\u3001\uff1b\uff1a]\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(first)) !== null) {
      const end = m.index + m[0].length;
      if (end <= FIRST_PART_MAX * scale && m.index >= 15 * scale) {
        cut = end;
      } else if (cut < 0 && end <= FIRST_PART_MAX * scale * 2) {
        cut = end;
        break;
      } else if (end > FIRST_PART_MAX * scale) {
        break;
      }
    }
    if (cut > 0) {
      // The opening clause becomes its own chunk (never re-merged below).
      chunks.push(first.slice(0, cut).trimEnd());
      sentences = [first.slice(cut), ...sentences.slice(1)];
    }
  }
  let cur = "";
  const join = dense ? "" : " ";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > targetAt(chunks.length)) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur}${join}${s}` : s;
    }
  }
  if (cur) {
    chunks.push(cur);
  }
  // Nothing without a letter or digit reaches an engine: Piper exits with a
  // traceback on input it cannot phonemize (a lone arrow, "...", a bidi mark).
  return chunks.filter((c) => /[\p{L}\p{N}]/u.test(c));
}

export interface Utterance {
  kind: "text" | "tool" | "error";
  text: string;
  /** Tool name, for "tool" and "error" kinds (undefined if unknown). */
  tool?: string;
}

export interface SpeakOptions {
  speakText: boolean;
  speakTools: boolean;
  speakErrors: boolean;
  speakSubagents: boolean;
  /** Prose chunk size(s); neural engines ramp small-to-large for fast start. */
  chunkChars?: number | number[];
  /** Nothing is playing: clause-split the opening sentence for fast first audio. */
  fastStart?: boolean;
}

/** First meaningful line of a tool error, cleaned for speech. */
function errorSummary(content: unknown): string {
  let raw = "";
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    const t = content.find((b: any) => b?.type === "text");
    raw = String(t?.text ?? "");
  }
  // eslint-disable-next-line no-control-regex -- the escape character is the thing being stripped
  raw = raw.replace(/\x1b\[[0-9;]*m/g, ""); // ANSI colors
  const first = raw.split("\n").find((l) => l.trim()) ?? "";
  const cleaned = cleanTextForSpeech(first).slice(0, 120);
  return cleaned;
}

/**
 * One transcript JSONL line -> utterances to speak (empty array = nothing).
 * `toolNames` maps tool_use ids to tool names across lines so errors can be
 * attributed ("Bash error: ..."); pass the same Map for every line.
 */
export function utterancesFromLine(line: string, opts: SpeakOptions, toolNames?: Map<string, string>): Utterance[] {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  // Subagent chatter
  if (entry?.isSidechain && !opts.speakSubagents) {
    return [];
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const out: Utterance[] = [];
  if (entry.type === "assistant") {
    for (const block of content) {
      if (block?.type === "text" && opts.speakText) {
        const t = cleanTextForSpeech(String(block.text ?? ""));
        if (t) {
          out.push(
            ...chunkForSpeech(t, opts.chunkChars, opts.fastStart ?? true).map((c) => ({
              kind: "text" as const,
              text: c,
            }))
          );
        }
      } else if (block?.type === "tool_use") {
        const name = String(block.name ?? "");
        if (toolNames && block.id) {
          toolNames.set(String(block.id), name);
          if (toolNames.size > 500) {
            toolNames.delete(toolNames.keys().next().value!);
          }
        }
        if (opts.speakTools) {
          const d = describeTool(name, block.input ?? {});
          if (d) {
            out.push({ kind: "tool", tool: name, text: d });
          }
        }
      }
    }
  } else if (entry.type === "user" && opts.speakErrors) {
    for (const block of content) {
      if (block?.type !== "tool_result" || !block.is_error) {
        continue;
      }
      const tool = toolNames?.get(String(block.tool_use_id ?? ""));
      const summary = errorSummary(block.content);
      out.push({
        kind: "error",
        tool,
        text: `${tool ?? "Tool"} error${summary ? `: ${summary}` : ""}`,
      });
    }
  }
  return out;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** Apply user-configured pronunciation replacements (whole-word, case-insensitive). */
export function applySubstitutions(text: string, subs: Record<string, string>): string {
  for (const [from, to] of Object.entries(subs)) {
    if (!from || typeof to !== "string") {
      continue;
    }
    const pattern = new RegExp(`\\b${from.replace(REGEX_SPECIALS, "\\$&")}\\b`, "gi");
    text = text.replace(pattern, to);
  }
  return text;
}
