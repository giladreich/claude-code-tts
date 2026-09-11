// A scriptable stand-in for the `vscode` module.
//
// The extension's whole front end (32 command handlers, the status bar, every
// picker) lives behind this API, and until this stub existed none of it was
// ever executed by a test: the only coverage was "activate() did not throw".
// That is not enough to refactor 2500 lines of UI safely, so this stub lets a
// test run a real command handler, answer its prompts, and assert on what the
// user would have seen.
//
// Defaults are "the user pressed Escape": every prompt resolves undefined, so
// a handler that is not scripted still runs its cancel path instead of hanging.
const Module = require("module");
const path = require("path");

/** The declared defaults, so inspect() can answer what the user has not set. */
const CONTRIBUTED = (() => {
  const pkg = require(path.join(__dirname, "..", "..", "package.json"));
  const sections = pkg.contributes.configuration;
  return Object.assign({}, ...(Array.isArray(sections) ? sections : [sections]).map((s) => s.properties));
})();

/** Recorded prompt, so a test can assert on what was shown. */
class Shown {
  constructor(kind, message, items, options) {
    this.kind = kind;
    this.message = message;
    this.items = items;
    this.options = options;
  }
}

/**
 * @param {object} [opts]
 * @param {Record<string, unknown>} [opts.settings] initial configuration values, dotted keys without the "claudeCodeTts." prefix
 * @param {Record<string, unknown>} [opts.globalState]
 */
function createVscodeStub(opts = {}) {
  const commands = new Map();
  const shown = [];
  const answers = [];
  const executed = [];
  const settings = new Map(Object.entries(opts.settings ?? {}));
  const globalState = new Map(Object.entries(opts.globalState ?? {}));
  const statusItems = [];
  const quickPicks = [];
  const output = [];
  const disposable = () => ({ dispose() {} });

  /**
   * The next scripted answer, or undefined (Escape). Answers are queued in the
   * order the flow will ask for them; a function is called with the prompt so
   * a test can choose by label.
   */
  const nextAnswer = (kind, message, items, options) => {
    shown.push(new Shown(kind, message, items, options));
    if (answers.length === 0) return undefined;
    const a = answers.shift();
    return typeof a === "function" ? a(items, message, options) : a;
  };

  const inputBoxes = [];
  const quickPick = () => {
    const qp = {
      items: [],
      activeItems: [],
      selectedItems: [],
      value: "",
      placeholder: "",
      title: "",
      busy: false,
      canSelectMany: false,
      matchOnDescription: false,
      matchOnDetail: false,
      ignoreFocusOut: false,
      buttons: [],
      _handlers: {},
      onDidChangeActive(fn) {
        qp._handlers.active = fn;
        return disposable();
      },
      onDidAccept(fn) {
        qp._handlers.accept = fn;
        return disposable();
      },
      onDidHide(fn) {
        qp._handlers.hide = fn;
        return disposable();
      },
      onDidChangeValue(fn) {
        qp._handlers.value = fn;
        return disposable();
      },
      onDidTriggerButton(fn) {
        qp._handlers.button = fn;
        return disposable();
      },
      show() {
        qp.shown = true;
        // The stub's contract is "the user pressed Escape": a picker that is
        // shown and never dismissed leaves the flow that opened it awaiting
        // forever, which is a hang in the test rather than in the extension.
        // Pass autoDismiss: false to drive one by hand.
        if (opts.autoDismiss !== false) setTimeout(() => qp.hide(), 0);
      },
      hide() {
        qp.shown = false;
        qp._handlers.hide?.();
      },
      dispose() {
        qp.disposed = true;
      },
    };
    quickPicks.push(qp);
    return qp;
  };

  // The same contract as the quick pick above: shown, then dismissed, so a
  // flow that asks a question completes instead of hanging the test.
  const inputBox = () => {
    const box = {
      value: "",
      prompt: "",
      title: "",
      placeholder: "",
      password: false,
      validationMessage: "",
      buttons: [],
      _handlers: {},
      onDidAccept(fn) {
        box._handlers.accept = fn;
        return disposable();
      },
      onDidHide(fn) {
        box._handlers.hide = fn;
        return disposable();
      },
      onDidChangeValue(fn) {
        box._handlers.value = fn;
        return disposable();
      },
      onDidTriggerButton(fn) {
        box._handlers.button = fn;
        return disposable();
      },
      show() {
        box.shown = true;
        if (opts.autoDismiss !== false) setTimeout(() => box.hide(), 0);
      },
      hide() {
        box.shown = false;
        box._handlers.hide?.();
      },
      dispose() {
        box.disposed = true;
      },
    };
    inputBoxes.push(box);
    return box;
  };

  const stub = {
    window: {
      createOutputChannel: () => ({
        appendLine: (l) => output.push(l),
        append: (l) => output.push(l),
        show() {},
        clear() {},
        dispose() {},
      }),
      createStatusBarItem: () => {
        const it = {
          text: "",
          tooltip: "",
          command: "",
          name: "",
          accessibilityInformation: undefined,
          show() {
            it.visible = true;
          },
          hide() {
            it.visible = false;
          },
          dispose() {},
        };
        statusItems.push(it);
        return it;
      },
      createQuickPick: quickPick,
      createInputBox: inputBox,
      createTerminal: () => ({ sendText() {}, show() {}, dispose() {} }),
      showQuickPick: async (items, options) =>
        nextAnswer("quickPick", options?.placeHolder ?? "", await items, options),
      showInputBox: async (options) => nextAnswer("input", options?.prompt ?? "", undefined, options),
      showInformationMessage: async (message, ...rest) => nextAnswer("info", message, flatItems(rest), rest[0]),
      showWarningMessage: async (message, ...rest) => nextAnswer("warning", message, flatItems(rest), rest[0]),
      showErrorMessage: async (message, ...rest) => nextAnswer("error", message, flatItems(rest), rest[0]),
      showOpenDialog: async (options) => nextAnswer("open", options?.title ?? "", undefined, options),
      showSaveDialog: async (options) => nextAnswer("save", options?.title ?? "", undefined, options),
      showTextDocument: async () => ({}),
      setStatusBarMessage: () => disposable(),
      withProgress: async (_options, task) =>
        task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
      state: { focused: true },
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return disposable();
      },
      executeCommand: async (id, ...args) => {
        executed.push(id);
        const handler = commands.get(id);
        return handler ? handler(...args) : undefined;
      },
      getCommands: async () => [...commands.keys()],
    },
    workspace: {
      workspaceFolders: opts.workspaceFolders,
      getConfiguration: (section) => ({
        get: (key, fallback) => {
          const full = section ? `${section}.${key}` : key;
          const short = full.replace(/^claudeCodeTts\./, "");
          return settings.has(short) ? settings.get(short) : fallback;
        },
        update: async (key, value) => {
          const short = `${section ? `${section}.${key}` : key}`.replace(/^claudeCodeTts\./, "");
          if (value === undefined) settings.delete(short);
          else settings.set(short, value);
        },
        // Real enough to answer "has the user set this themselves?", which is
        // what the machine-tuned defaults ask before writing anything.
        inspect: (key) => {
          const full = section ? `${section}.${key}` : key;
          const short = full.replace(/^claudeCodeTts\./, "");
          return {
            key: full,
            defaultValue: CONTRIBUTED[full]?.default,
            globalValue: settings.has(short) ? settings.get(short) : undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
          };
        },
      }),
      onDidChangeConfiguration: () => disposable(),
      onDidChangeWorkspaceFolders: () => disposable(),
      openTextDocument: async () => ({}),
      fs: { stat: async () => ({}) },
    },
    env: {
      language: opts.language ?? "en",
      openExternal: async () => true,
      clipboard: { writeText: async () => {}, readText: async () => opts.clipboard ?? "" },
    },
    Uri: {
      file: (p) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
      parse: (s) => ({ fsPath: s, scheme: "https", path: s, toString: () => s }),
      joinPath: (base, ...parts) => stub.Uri.file(path.join(base.fsPath, ...parts)),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
    QuickInputButtons: { Back: { tooltip: "Back" } },
    ThemeIcon: class ThemeIcon {
      constructor(id) {
        this.id = id;
      }
    },
    EventEmitter: class EventEmitter {
      constructor() {
        this.listeners = [];
        this.event = (fn) => {
          this.listeners.push(fn);
          return disposable();
        };
      }
      fire(value) {
        for (const l of this.listeners) l(value);
      }
      dispose() {}
    },
  };

  /** Extension context matching what activate() uses. */
  const context = (storage) => ({
    subscriptions: [],
    extensionPath: path.resolve(__dirname, "..", ".."),
    globalStorageUri: { fsPath: storage },
    globalState: {
      get: (k, d) => (globalState.has(k) ? globalState.get(k) : d),
      update: async (k, v) => void (v === undefined ? globalState.delete(k) : globalState.set(k, v)),
      keys: () => [...globalState.keys()],
    },
    workspaceState: {
      get: (k, d) => d,
      update: async () => {},
    },
  });

  return {
    stub,
    context,
    commands,
    shown,
    executed,
    settings,
    globalState,
    statusItems,
    quickPicks,
    inputBoxes,
    output,
    /** Queue answers for the next prompts, in order. */
    answer: (...values) => answers.push(...values),
    /** Everything queued was consumed. */
    answersLeft: () => answers.length,
  };
}

/** Buttons passed to showInformationMessage, ignoring a leading options object. */
function flatItems(rest) {
  const items = rest.filter((r) => typeof r === "string");
  return items.length ? items : undefined;
}

/** Make `require("vscode")` resolve to this stub for the rest of the process. */
function installVscodeStub(stub) {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") return "vscode-stub";
    return orig.call(this, request, ...rest);
  };
  require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: stub };
}

module.exports = { createVscodeStub, installVscodeStub };
