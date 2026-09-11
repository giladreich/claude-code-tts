# Changelog

Notable changes to Claude Code TTS, newest first. Entries are one line: what
changed for you. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

- Export what was spoken to a file: the last message, or any part of what was played, as an MP3 (or M4A, Opus, FLAC, WAV), in the voice, at the rate and in the language it was heard. The sheet shows the size the file will be as the quality and the range are chosen, each sentence can be heard and left out, and the pauses between sentences are kept natural. The last 30 minutes of speech are kept for it (`export.keepMinutes`; 0 keeps nothing).
- The menu rows "Set speech rate" and "Show spoken log", and a few other prompts, had lost words to the rename and read "runtime.speech"; they read as intended again.
- Downloads (Kokoro, Piper voices, the private uv) go through the proxy VSCode is configured for (`http.proxy`), or the one in `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. On a machine that reaches the internet only through a proxy they failed with a connection error while the Python side worked.
- On Linux under an editor whose Node cannot watch a directory tree (VSCode before 1.90), and on a machine out of inotify watches, transcripts are found by scanning instead. Before, a new session was never spoken there, and on the older editors the extension did not start at all.
- Piper reads its text as UTF-8 on Windows; a sentence with an accent or another script in it was mispronounced from the system code page. The system voice's PowerShell reads its text the same way.
- A `~/.claude/settings.json` that cannot be parsed (a byte order mark from an editor, a stray comma) is left alone rather than replaced by the completion-sound hooks, and the hook script reads a file with a byte order mark.
- The install command offered for ffmpeg names the package manager on the machine (apt, dnf, pacman, zypper, Homebrew) rather than always apt, and on Windows says to restart VSCode afterwards, which a winget install needs before the program is found.
- Piper is found on disk rather than by running it, which no longer stalls activation for a Python start-up; probes and archive tools no longer flash a console window on Windows; and a microphone recording stopped early on Windows is complete rather than empty (ffmpeg there cannot be asked to stop through a pipe, so it is stopped the hard way and its header repaired).

## [1.0.1]

- The store page shows the two diagrams as pictures. The Marketplace has no mermaid renderer, so both arrived as a wall of `flowchart LR` text where a diagram was meant to be.
- Switching to "speak every session" no longer loses the first line written at that moment. The position of a file being skipped was moved forward by a check that could finish after the switch, and whatever arrived in between was stepped over.
- Easier to find: the extension is listed under AI and Chat rather than AI and Other, and the search terms it answers to now include the names of the engines it installs.

## [1.0.0]

First public release.

- Settings you set while this was called Claude Voice are carried over: the extension had to be renamed, so `claudeVoice.*` became `claudeCodeTts.*`, and each value moves to its new name the first time this version starts.
- Speaks Claude Code's replies aloud and announces its tool calls ("Bash: run tests"), reading prose and never code.
- Five local speech engines: the system voice, which needs no setup, and Kokoro, Piper, Qwen3 and Chatterbox, each installed from inside the extension when you want it. "Set Up the Best Voice" picks the one that suits this machine and the languages you listen to.
- A voice of your own, recorded in ten seconds, taken from audio or video you already have, or described in words and rendered locally. Voices can be backed up to a file and imported again.
- 23 languages in a voice you create, and translation of everything into the one you prefer, on this machine.
- Completion sounds through Claude Code's own hooks, so they play whether or not the editor is speaking, with a sound per event.
- Everything is local: no cloud speech, no telemetry, no account, no API key. Model downloads are the only network use, and each one is asked for first.
- "Storage and Cleanup" measures what has been downloaded, marks what the current settings need, and frees the rest; "Remove Everything Claude Code TTS Added" undoes the installation.
- Keyboard shortcuts for the whole of it, a status bar menu, and one-word control from a terminal (`echo mute > ~/.claude/claude-code-tts-control`).
