import * as vscode from "vscode";
import { config } from "../core/config";
import { runtime } from "../core/runtime";
import { SpeechConfig } from "../speech/speech";
import { playWavFile } from "../tts/synthPlay";

/**
 * A quick pick that auditions what is highlighted.
 *
 * Every voice picker in this extension previews on highlight, because
 * choosing a voice by reading its name is guesswork. One list did not: the
 * voice manager made you select a voice and then held the sample behind a
 * modal dialog with a Stop button, which is three interactions to hear one
 * thing. This is the shared piece, free of any engine: the caller says how
 * to start a preview and how to stop it.
 */
export function pickWithPreview<T extends vscode.QuickPickItem>(opts: {
  items: T[];
  placeholder: string;
  matchOnDetail?: boolean;
  /** Start playing this item; returns how to stop it. undefined = nothing to hear. */
  preview: (item: T) => { stop: () => void } | undefined;
  /** Wait this long after the highlight settles, so scrolling does not stutter. */
  debounceMs?: number;
  /** Shown above the list, next to the back arrow when there is one. */
  title?: string;
  /**
   * There is a menu behind this list: a back arrow appears in the title bar
   * and Escape answers "back" instead of closing everything, so a list two
   * levels in can be left without starting again from the status bar.
   */
  back?: boolean;
}): Promise<T | "back" | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    qp.items = opts.items;
    qp.placeholder = opts.placeholder;
    if (opts.title) {
      qp.title = opts.title;
    }
    if (opts.back) {
      qp.buttons = [vscode.QuickInputButtons.Back];
    }
    qp.matchOnDetail = opts.matchOnDetail ?? true;
    let playing: { stop: () => void } | undefined;
    let timer: NodeJS.Timeout | undefined;
    // The picker fires onDidChangeActive for its own first row as it opens.
    // Previewing that would speak at the user before they touched anything.
    const shownAt = Date.now();
    const stop = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
      playing?.stop();
      playing = undefined;
    };
    qp.onDidChangeActive((active) => {
      const item = active[0];
      if (!item) {
        return;
      }
      if (Date.now() - shownAt < 400 && item === qp.items[0]) {
        return;
      }
      stop();
      timer = setTimeout(() => (playing = opts.preview(item)), opts.debounceMs ?? 250);
    });
    let picked: T | "back" | undefined;
    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        picked = "back";
        qp.hide();
      }
    });
    qp.onDidAccept(() => {
      picked = qp.selectedItems[0];
      qp.hide();
    });
    qp.onDidHide(() => {
      stop();
      qp.dispose();
      resolve(picked ?? (opts.back ? "back" : undefined));
    });
    qp.show();
  });
}

/**
 * Offer a command the extension cannot run for the user (system packages
 * such as ffmpeg need a package manager and often sudo). "Run in Terminal"
 * opens the integrated terminal with the command typed but NOT executed, so
 * the user reads it and presses Enter; "Copy" is for another shell.
 */
export async function offerCommand(
  message: string,
  command: string,
  ...moreButtons: string[]
): Promise<string | undefined> {
  const RUN = "Run in Terminal";
  const COPY = "Copy the command";
  const pick = await vscode.window.showWarningMessage(message, RUN, COPY, ...moreButtons);
  if (pick === RUN) {
    const terminal = vscode.window.createTerminal({ name: "Claude Code TTS setup" });
    terminal.show();
    terminal.sendText(command, false);
    return undefined;
  }
  if (pick === COPY) {
    await vscode.env.clipboard.writeText(command);
    return undefined;
  }
  return pick;
}

/**
 * Answered instead of a value when a step was left rather than filled in.
 *
 * A symbol rather than the string "back": these boxes take text a person
 * types, and "back" is text a person can type. Naming a voice "back" would
 * otherwise have counted as pressing the back arrow.
 */
export const BACK = Symbol("back");

export type Back = typeof BACK;

/**
 * An input box that can be left the way a list can: a back arrow in the
 * title bar, and Escape answering BACK rather than abandoning the whole
 * flow. Every step of every flow takes one of these, so "go back one step"
 * means the same thing everywhere: describing a voice, naming it, typing a
 * time range or a rate are all steps someone reconsiders.
 */
export function inputWithBack(
  opts: {
    prompt: string;
    title?: string;
    value?: string;
    placeHolder?: string;
    password?: boolean;
    validateInput?: (value: string) => string | undefined;
  },
  back = false
): Promise<string | Back | undefined> {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.prompt = opts.prompt;
    if (opts.title) {
      box.title = opts.title;
    }
    if (opts.value !== undefined) {
      box.value = opts.value;
    }
    if (opts.placeHolder) {
      box.placeholder = opts.placeHolder;
    }
    if (opts.password) {
      box.password = true;
    }
    if (back) {
      box.buttons = [vscode.QuickInputButtons.Back];
    }
    let answer: string | Back | undefined;
    box.onDidChangeValue((value) => {
      box.validationMessage = opts.validateInput?.(value) ?? "";
    });
    box.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        answer = BACK;
        box.hide();
      }
    });
    box.onDidAccept(() => {
      const problem = opts.validateInput?.(box.value);
      if (problem) {
        box.validationMessage = problem;
        return;
      }
      answer = box.value;
      box.hide();
    });
    box.onDidHide(() => {
      box.dispose();
      resolve(answer ?? (back ? BACK : undefined));
    });
    box.show();
  });
}

/**
 * A multi-select list with the same way out. Returns the chosen items, or
 * "back" when the step was left rather than answered.
 */
export function pickManyWithBack<T extends vscode.QuickPickItem>(opts: {
  items: T[];
  placeholder: string;
  title?: string;
  back?: boolean;
}): Promise<T[] | "back" | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    qp.items = opts.items;
    qp.placeholder = opts.placeholder;
    qp.canSelectMany = true;
    if (opts.title) {
      qp.title = opts.title;
    }
    if (opts.back) {
      qp.buttons = [vscode.QuickInputButtons.Back];
    }
    qp.selectedItems = opts.items.filter((i) => (i as vscode.QuickPickItem & { picked?: boolean }).picked);
    let answer: T[] | "back" | undefined;
    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        answer = "back";
        qp.hide();
      }
    });
    qp.onDidAccept(() => {
      answer = [...qp.selectedItems];
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(answer ?? (opts.back ? "back" : undefined));
    });
    qp.show();
  });
}

/**
 * What a menu did, so the menu that opened it knows what to do next.
 *
 * "ran" means something happened and this menu should be shown again: most
 * settings are changed one after another (three completion sounds, a voice
 * then a rate), and closing the menu after each one made every second change
 * start from the status bar again. "back" is the way out to the menu behind
 * this one, and "closed" ends the whole thing.
 */
export type MenuOutcome = "ran" | "back" | "closed";

/** One row of a menu: either a command to run, or something to do here. */
export interface MenuRow extends vscode.QuickPickItem {
  command?: string;
  /** Arguments for that command, so a menu can tell it there is a way back. */
  args?: unknown[];
  /** Returning "back" means a submenu was left, so this menu comes back. */
  run?: () => unknown;
  /** Close instead of showing this menu again: the row opened something else. */
  closeAfter?: boolean;
}

/**
 * Show a menu and run what was picked.
 *
 * `back` says there is a menu behind this one: a back arrow appears in the
 * title bar and Escape goes there rather than closing everything, which is
 * what a nested menu needs to be usable at all.
 */
export async function runMenu(rows: MenuRow[], placeHolder: string, back = false): Promise<MenuOutcome> {
  const qp = vscode.window.createQuickPick<MenuRow>();
  qp.items = rows.filter((r) => r.label);
  qp.placeholder = placeHolder;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  if (back) {
    qp.buttons = [vscode.QuickInputButtons.Back];
  }
  const picked = await new Promise<MenuRow | "back" | undefined>((resolve) => {
    let answer: MenuRow | "back" | undefined;
    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        answer = "back";
        qp.hide();
      }
    });
    qp.onDidAccept(() => {
      answer = qp.selectedItems[0];
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(answer);
    });
    qp.show();
  });
  if (picked === "back") {
    return "back";
  }
  if (!picked) {
    return back ? "back" : "closed";
  }
  const result = picked.command
    ? await vscode.commands.executeCommand(picked.command, ...(picked.args ?? []))
    : await picked.run?.();
  // A submenu that was left with Escape says so, and this menu comes back
  // even when the row would otherwise have closed it; one that ended for
  // good takes this menu with it.
  if (result === "back") {
    return "ran";
  }
  if (result === "closed") {
    return "closed";
  }
  return picked.closeAfter ? "closed" : "ran";
}

/**
 * A quick pick that can be left the way a menu can: a back arrow in the title
 * bar and Escape returning to whatever opened it, rather than closing
 * everything and starting again from the status bar. Every list this
 * extension shows takes it, so going back works the same everywhere.
 */
export async function pickWithBack<T extends vscode.QuickPickItem>(
  items: T[],
  options: { placeHolder: string; title?: string; matchOnDetail?: boolean; matchOnDescription?: boolean },
  back = false
): Promise<T | "back" | undefined> {
  const qp = vscode.window.createQuickPick<T>();
  qp.items = items;
  qp.placeholder = options.placeHolder;
  if (options.title) {
    qp.title = options.title;
  }
  if (options.matchOnDetail) {
    qp.matchOnDetail = true;
  }
  if (options.matchOnDescription) {
    qp.matchOnDescription = true;
  }
  if (back) {
    qp.buttons = [vscode.QuickInputButtons.Back];
  }
  return new Promise<T | "back" | undefined>((resolve) => {
    let answer: T | "back" | undefined;
    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        answer = "back";
        qp.hide();
      }
    });
    qp.onDidAccept(() => {
      answer = qp.selectedItems[0];
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(answer ?? (back ? "back" : undefined));
    });
    qp.show();
  });
}

/**
 * Show a menu until it is left. Every menu below the top level loops: a
 * setting is changed and the same list comes back, so the next one is one
 * keypress away rather than five.
 */
export async function menuLoop(show: (back: boolean) => Promise<MenuOutcome>, back: boolean): Promise<MenuOutcome> {
  for (;;) {
    const outcome = await show(back);
    if (outcome !== "ran") {
      return outcome;
    }
  }
}

export const separator = (label: string): MenuRow => ({ label, kind: vscode.QuickPickItemKind.Separator });

/**
 * Quick picks fire one active-change right after show() for the first item.
 * That is not the user auditioning anything, so skip it; a real arrow press
 * lands on another item or comes later.
 */
export function isInitialActivation(
  qp: vscode.QuickPick<vscode.QuickPickItem>,
  active: readonly vscode.QuickPickItem[],
  shownAt: number
): boolean {
  return Date.now() - shownAt < 400 && active[0] === qp.items[0];
}

/**
 * A quick pick that speaks the highlighted item, debounced, with a busy
 * indicator while the sample is being synthesized. Every voice and rate
 * picker in the extension is built from this, so auditioning behaves the
 * same everywhere: nothing is lost to an audition (the interrupted utterance
 * is re-queued), a newer highlight supersedes the previous sample, and
 * closing the picker stops it at once.
 */
export function livePreviewPicker<T extends vscode.QuickPickItem>(opts: {
  items: T[];
  placeholder: string;
  /** Shown above the list, with the back arrow when there is one. */
  title?: string;
  matchOnDetail?: boolean;
  debounceMs?: number;
  /**
   * There is a menu behind this one: a back arrow appears in the title bar
   * and Escape returns there instead of closing everything.
   */
  back?: boolean;
  /**
   * What to speak for an item; undefined skips previewing it. A `file` is a
   * ready-made recording played as it is, which is how a voice can be heard
   * before the model that speaks it has been downloaded, and how a
   * notification sound is auditioned.
   */
  sample: (item: T) =>
    | {
        text: string;
        voice: string;
        rate?: number;
        engine?: SpeechConfig["engine"];
        inVoice?: string;
        file?: string;
        volume?: number;
      }
    | undefined;
  accept: (item: T) => Promise<void> | void;
}): Promise<MenuOutcome> {
  const qp = vscode.window.createQuickPick<T>();
  let playing: { stop: () => void } | undefined;
  qp.items = opts.items;
  qp.placeholder = opts.placeholder;
  if (opts.title) {
    qp.title = opts.title;
  }
  if (opts.back) {
    qp.buttons = [vscode.QuickInputButtons.Back];
  }
  if (opts.matchOnDetail) {
    qp.matchOnDetail = true;
  }
  const shownAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  return new Promise<MenuOutcome>((resolve) => {
    let outcome: MenuOutcome | undefined;
    const finish = (value: MenuOutcome) => {
      outcome = value;
      qp.hide();
    };
    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish("back");
      }
    });
    qp.onDidChangeActive((active) => {
      if (isInitialActivation(qp, active, shownAt)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      const item = active[0];
      if (!item) {
        return;
      }
      const s = opts.sample(item);
      if (!s) {
        return;
      }
      timer = setTimeout(() => {
        if (s.file) {
          // Nothing to synthesize and nothing to interrupt: a ready-made
          // sample is just audio, so it plays at once even with no model on
          // the machine.
          runtime.speech?.stopPreview();
          playing?.stop();
          playing = playWavFile(s.file, s.volume ?? config().speechConfig.volume);
          return;
        }
        qp.busy = true; // synthesis takes a moment: show that something is coming
        runtime.speech?.preview(
          s.text,
          s.voice,
          s.rate,
          () => {
            qp.busy = false;
          },
          s.engine,
          s.inVoice
        );
      }, opts.debounceMs ?? 250);
    });
    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0];
      outcome = "ran";
      qp.hide();
      if (item) {
        await opts.accept(item);
      }
      resolve("ran");
    });
    qp.onDidHide(() => {
      if (timer) {
        clearTimeout(timer);
      }
      playing?.stop();
      runtime.speech?.stopPreview(); // cut any playing sample; the main queue resumes
      qp.dispose();
      // Accepting resolves once its handler has finished, not here.
      if (outcome !== "ran") {
        resolve(outcome ?? (opts.back ? "back" : "closed"));
      }
    });
    qp.show();
  });
}
