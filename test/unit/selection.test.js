const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSpeakTarget, clipboardTarget } = require("../../out/session/selection.js");

function deps({ editor = "", clipboard = "", commands = ["execCopy"], onCopy } = {}) {
  const state = { clipboard, writes: [], ran: [] };
  return {
    state,
    api: {
      editorSelection: () => editor,
      readClipboard: async () => state.clipboard,
      writeClipboard: async (t) => {
        state.writes.push(t);
        state.clipboard = t;
      },
      copyCommands: async () => commands,
      runCommand: async (id) => {
        state.ran.push(id);
        if (onCopy) state.clipboard = onCopy;
      },
    },
  };
}

test("an editor selection is used directly, without touching the clipboard", async () => {
  const d = deps({ editor: "hello from the editor", clipboard: "keep me" });
  const r = await resolveSpeakTarget(d.api);
  assert.deepEqual(r, { text: "hello from the editor", source: "editor" });
  assert.deepEqual(d.state.ran, []);
  assert.equal(d.state.clipboard, "keep me");
});

test("a webview selection is copied, spoken, and the clipboard is restored", async () => {
  const d = deps({ clipboard: "previous clipboard", onCopy: "text selected in Claude's chat" });
  const r = await resolveSpeakTarget(d.api);
  assert.deepEqual(r, { text: "text selected in Claude's chat", source: "selection" });
  assert.deepEqual(d.state.ran, ["execCopy"]);
  assert.equal(d.state.clipboard, "previous clipboard", "the user's clipboard is put back");
});

test("nothing selected: the clipboard is spoken and reported as such", async () => {
  const d = deps({ clipboard: "something copied earlier" });
  const r = await resolveSpeakTarget(d.api);
  assert.deepEqual(r, { text: "something copied earlier", source: "clipboard" });
  assert.deepEqual(d.state.writes, [], "an unchanged clipboard is not rewritten");
});

test("every available copy command is tried before giving up", async () => {
  const tried = [];
  const api = {
    editorSelection: () => "",
    readClipboard: async () => "old",
    writeClipboard: async () => {},
    copyCommands: async () => [
      "execCopy",
      "editor.action.clipboardCopyAction",
      "workbench.action.terminal.copySelection",
    ],
    runCommand: async (id) => {
      tried.push(id);
    },
  };
  const r = await resolveSpeakTarget(api);
  assert.deepEqual(tried, ["execCopy", "editor.action.clipboardCopyAction", "workbench.action.terminal.copySelection"]);
  assert.equal(r.source, "clipboard", "falls back to the clipboard when no view yields its selection");
});

test("clipboardTarget speaks whatever was copied, and reports an empty clipboard", async () => {
  assert.deepEqual(await clipboardTarget({ readClipboard: async () => "copied from the chat panel" }), {
    text: "copied from the chat panel",
    source: "clipboard",
  });
  assert.deepEqual(await clipboardTarget({ readClipboard: async () => "   " }), { text: "", source: "none" });
});

test("nothing anywhere yields no text; a missing copy command is not fatal", async () => {
  assert.deepEqual(await resolveSpeakTarget(deps({}).api), { text: "", source: "none" });
  const d = deps({ clipboard: "x", commands: [] });
  const r = await resolveSpeakTarget(d.api);
  assert.deepEqual(r, { text: "x", source: "clipboard" });
  assert.deepEqual(d.state.ran, [], "no copy command available: none is invoked");
  const boom = deps({ clipboard: "y" });
  boom.api.runCommand = async () => {
    throw new Error("view refused to copy");
  };
  assert.deepEqual(await resolveSpeakTarget(boom.api), { text: "y", source: "clipboard" });
});
