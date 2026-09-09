/**
 * Commands that exist but are not in the palette, and why.
 *
 * Both lists are contracts rather than trivia: a test asserts that every
 * command hidden from the palette is either reachable from a flow or listed
 * here, so hiding one can never quietly orphan it.
 */
/**
 * Registered but never declared in package.json: these take an argument from
 * the picker that invokes them, so showing them to a user would be a dead
 * end with no way to supply it.
 */
export const INTERNAL_COMMANDS = ["claudeCodeTts.downloadVoiceForLanguage"];

/**
 * Declared and registered, hidden from the palette, kept because someone may
 * have bound them. "Speak Selection" and "Speak Clipboard" are one command
 * now (the selection path already falls back to the clipboard) and the Piper
 * download is reached while choosing an engine or a voice, but a user's
 * keybindings do not know that.
 */
export const LEGACY_COMMANDS = [
  "claudeCodeTts.speakSelection",
  "claudeCodeTts.speakClipboard",
  "claudeCodeTts.downloadVoice",
];
