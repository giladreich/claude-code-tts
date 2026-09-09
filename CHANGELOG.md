# Changelog

Notable changes to Claude Code TTS, newest first. Entries are one line: what
changed for you. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1]

- The store page shows the two diagrams as pictures. The Marketplace has no mermaid renderer, so both arrived as a wall of `flowchart LR` text where a diagram was meant to be.
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
