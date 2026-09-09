// Activation smoke test: loads the compiled extension against a stub vscode
// API, runs activate(), and verifies every command declared in package.json
// was registered. Catches ordering/undefined crashes before packaging.
const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const registered = new Set();
const noop = () => ({ dispose() {} });
const item = () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} });
const vscodeStub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: item,
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: noop,
    state: { focused: true },
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: (id) => (registered.add(id), noop()),
    executeCommand: () => Promise.resolve(),
    getCommands: () => Promise.resolve([]),
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      // Silent and local: the smoke test proves activation wires up, and
      // must not speak or reach for another window's sessions to do it.
      get: (k, d) => ({ enabled: false, volume: 0, listenTo: "workspace" })[k] ?? d,
      update: () => Promise.resolve(),
      inspect: () => undefined,
    }),
    onDidChangeConfiguration: noop,
    onDidChangeWorkspaceFolders: noop,
  },
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: { parse: (s) => s },
  env: { openExternal() {}, clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve("") } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode-stub";
  return origResolve.call(this, request, ...rest);
};
require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: vscodeStub };

// A home of its own. Without it this test watches the developer's real
// ~/.claude, and since a window now speaks every session on the machine by
// default, running the suite while Claude Code is working would make the
// machine talk, differently on every run.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cv-smoke-home-"));
fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "cv-smoke-"));
const ext = require(path.resolve("out/extension.js"));
const context = {
  subscriptions: [],
  extensionPath: path.resolve("."),
  globalStorageUri: { fsPath: storage },
  globalState: { get: (_k, d) => d, update: () => Promise.resolve() },
};
try {
  ext.activate(context);
} catch (e) {
  console.error("ACTIVATION CRASHED:", e.stack);
  process.exit(1);
}
const declared = require(path.resolve("package.json")).contributes.commands.map((c) => c.command);
const missing = declared.filter((c) => !registered.has(c));
for (const d of context.subscriptions) d.dispose?.();
ext.deactivate?.();
fs.rmSync(storage, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
if (missing.length) {
  console.error("commands declared but not registered:", missing);
  process.exit(1);
}
console.log(`activation smoke test PASS (${declared.length} commands registered)`);
process.exit(0);
