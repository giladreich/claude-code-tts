const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanTextForSpeech,
  describeTool,
  chunkForSpeech,
  utterancesFromLine,
  applySubstitutions,
} = require("../../out/speech/format.js");

test("code blocks, tables, rules and URLs are not spoken", () => {
  const md =
    "Intro line.\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nSee https://example.com/x for details.";
  const s = cleanTextForSpeech(md);
  assert.ok(!s.includes("const x"));
  assert.ok(!s.includes("| a"));
  assert.ok(!s.includes("---"));
  assert.ok(s.includes("See link for details"));
  assert.ok(s.startsWith("Intro line."));
});

test("unclosed fence drops the tail; markdown decorations are stripped", () => {
  assert.equal(cleanTextForSpeech("Before.\n```\ncode"), "Before.");
  assert.equal(cleanTextForSpeech("# Title\n\n**bold** and _it_ and `code`"), "Title. bold and it and code");
  assert.equal(cleanTextForSpeech("- one\n- two\n1. three"), "one. two. three.");
  assert.equal(
    cleanTextForSpeech("## Next steps\n\n1. Reload the window\n2. Run tests."),
    "Next steps. Reload the window. Run tests."
  );
  assert.equal(cleanTextForSpeech("- **Player**: stream ids\n- Daemon: cancel"), "Player: stream ids. Daemon: cancel.");
  assert.equal(
    cleanTextForSpeech("Call `cleanTextForSpeech` or `parse_time_range`, see `HTTPServer`."),
    "Call clean Text For Speech or parse time range, see HTTP Server."
  );
  assert.equal(cleanTextForSpeech("[label](https://x.y/z) ![img](a.png)"), "label");
});

test("indented prose is kept, indented code is dropped", () => {
  // Kept as prose (not mistaken for code); the list number itself is not read.
  assert.equal(cleanTextForSpeech("Steps:\n    4. Restart (optional)"), "Steps: Restart (optional).");
  assert.equal(cleanTextForSpeech("Steps:\n    const a = 1;"), "Steps:");
  assert.equal(cleanTextForSpeech("Look at /Users/me/proj/src/extension.ts now"), "Look at extension.ts now");
});

test("describeTool covers every tool shape", () => {
  assert.equal(describeTool("Bash", { description: "Run tests", command: "npm test" }), "Bash: Run tests");
  assert.equal(
    describeTool("Bash", { command: "git status --short && echo ok" }),
    "Bash: git status --short && echo ok"
  );
  assert.equal(describeTool("Read", { file_path: "/a/b/c.ts" }), "Reading c.ts");
  assert.equal(describeTool("Edit", { file_path: "/a/b/c.ts" }), "Editing c.ts");
  assert.equal(describeTool("NotebookEdit", { notebook_path: "/n.ipynb" }), "Editing n.ipynb");
  assert.equal(describeTool("Grep", { pattern: "foo" }), "Searching for foo");
  assert.equal(describeTool("Agent", { description: "Find usages" }), "Launching agent: Find usages");
  assert.equal(describeTool("mcp__github__list_prs", {}), "github list prs");
  assert.match(
    describeTool("AskUserQuestion", {
      questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }, { question: "And?" }],
    }),
    /Claude asks: Which\? Options: A, B\. And 1 more question\./
  );
});

test("chunking is lossless and fast-start splits only a long opening sentence", () => {
  const text =
    "Two separate concerns, and the first one needs evidence before I touch code, because it may be a data-source problem. Then a second sentence follows. And a third one that is also fairly long to push over the target.";
  const fast = chunkForSpeech(text, [150, 350, 600]);
  assert.equal(fast[0], "Two separate concerns,");
  assert.equal(fast.join(" "), text);
  const slow = chunkForSpeech(text, [150, 350, 600], false);
  assert.ok(slow[0].startsWith("Two separate concerns, and the first"));
  assert.equal(slow.join(" "), text);
  assert.deepEqual(chunkForSpeech("Done.", [150]), ["Done."]);
  const noComma = "This is a rather long opening sentence without any clause punctuation at all that keeps going";
  assert.deepEqual(chunkForSpeech(noComma, [150]), [noComma]);
  const many = Array(10).fill("Short sentence here.").join(" ");
  const uniform = chunkForSpeech(many, 60, false);
  assert.ok(uniform.length >= 3 && uniform.every((c) => c.length <= 62));
});

test("utterancesFromLine handles text, tools, errors, sidechains", () => {
  const opts = { speakText: true, speakTools: true, speakErrors: true, speakSubagents: false, chunkChars: 260 };
  const names = new Map();
  const line = (o) => JSON.stringify(o);
  const a = utterancesFromLine(
    line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello **there**." },
          { type: "tool_use", id: "t1", name: "Bash", input: { description: "List files" } },
        ],
      },
    }),
    opts,
    names
  );
  assert.deepEqual(
    a.map((u) => [u.kind, u.text]),
    [
      ["text", "Hello there."],
      ["tool", "Bash: List files"],
    ]
  );
  const ansi = "\x1b[31mcommand not found: foo\x1b[0m\nmore";
  const err = utterancesFromLine(
    line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: ansi }] },
    }),
    opts,
    names
  );
  assert.deepEqual(
    err.map((u) => u.text),
    ["Bash error: command not found: foo"]
  );
  assert.deepEqual(
    utterancesFromLine(
      line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } }),
      opts
    ),
    []
  );
  assert.deepEqual(utterancesFromLine("not json", opts), []);
  assert.deepEqual(
    utterancesFromLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "```\ncode only\n```" }] } }),
      opts
    ),
    []
  );
});

test("substitutions are whole-word and case-insensitive", () => {
  assert.equal(applySubstitutions("Open README and readme.md", { README: "read me" }), "Open read me and read me.md");
  assert.equal(applySubstitutions("k8s cluster", { k8s: "kubernetes" }), "kubernetes cluster");
  assert.equal(applySubstitutions("x", { "": "y", a: 5 }), "x");
});

test("symbols that no engine can say are cleaned away or become words", () => {
  // Piper exits with a traceback on input it cannot phonemize; nothing like
  // that may reach an engine.
  assert.equal(cleanTextForSpeech("→"), "");
  assert.equal(cleanTextForSpeech("..."), "");
  assert.equal(cleanTextForSpeech("- - -"), "");
  assert.equal(cleanTextForSpeech("Step 1 → Step 2 ⇒ done"), "Step 1 to Step 2 to done");
  assert.equal(cleanTextForSpeech("a -> b and c => d"), "a to b and c to d");
  // Bidi and zero-width format characters are invisible and crash Piper.
  assert.equal(cleanTextForSpeech("‏שלום‎ world​"), "שלום world");
  assert.equal(cleanTextForSpeech("• first item"), "first item.");
  assert.deepEqual(chunkForSpeech("...", [150]), []);
});

test("sentence splitting does not cut numbers or versions apart", () => {
  const text =
    "Similarity rises from 0.45 to 0.71 in version 1.32.0. The next sentence follows. And a third one ends here.";
  const chunks = chunkForSpeech(text, [60, 300], false);
  assert.ok(chunks[0].includes("0.45 to 0.71 in version 1.32.0."), JSON.stringify(chunks));
  assert.ok(!chunks.some((c) => /^\d/.test(c)), `a chunk started mid-number: ${JSON.stringify(chunks)}`);
  // CJK sentences still split at their own marks, which no space follows.
  const zh = chunkForSpeech("第一句话说完了。第二句话开始了。第三句话也来了。第四句话结束。", [12, 12], false);
  assert.ok(zh.length >= 2, JSON.stringify(zh));
});

test("Hindi splits at the danda, not only at full stops", () => {
  // Devanagari ends sentences with U+0964. Without it a Hindi paragraph was
  // one chunk that could never be split, so it was synthesised in one piece.
  const hi = "शुरू करने से पहले एक छोटी सी बात। मैं लगभग रोज़ सॉफ़्टवेयर बनाता हूँ। कुछ बिगड़े तो जड़ तक पहुँचता हूँ।";
  const chunks = chunkForSpeech(hi, 40, false);
  assert.equal(chunks.length, 3, `expected three sentences, got ${JSON.stringify(chunks)}`);
  assert.ok(chunks[0].endsWith("।"));
});

test("a slash between two words is not a path", () => {
  // Each of these was glued into one word by a pattern that matched from the
  // slash: "and/or" was read as "andor", "24/7" as "247".
  for (const [text, expected] of [
    ["Use it and/or drop it.", "Use it and/or drop it."],
    ["The service runs 24/7.", "The service runs 24/7."],
    ["Check input/output first.", "Check input/output first."],
    ["Reading src/speech/speech.ts now.", "Reading speech.ts now."],
    ["Look at /Users/me/proj/src/extension.ts now", "Look at extension.ts now"],
    ["Open ./scripts/build.sh please.", "Open build.sh please."],
    ["It is in ~/dev/proj/notes.md today.", "It is in notes.md today."],
    ["The a/b/c experiment failed.", "The c experiment failed."],
  ]) {
    assert.equal(cleanTextForSpeech(text), expected, text);
  }
});
