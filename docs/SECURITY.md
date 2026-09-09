# Security

## Reporting a vulnerability

Report privately through GitHub's "Report a vulnerability" button on the Security tab, or by email to the address on the maintainer's GitHub profile. Please include the extension version, your platform, and a way to reproduce. You will get an acknowledgement within a week.

## What the threat model looks like here

The extension has no server, no accounts and no runtime npm dependencies. It reads transcript files Claude Code writes, and it starts local child processes: the OS speech tools, Python synthesis daemons, and small compiled helpers. The interesting attack surface is therefore:

- **Content it speaks.** Transcript text is treated as data. It reaches the engines through argv or stdin, never a shell; `say`'s embedded-command syntax is neutralised (`src/tts/system.ts`).
- **Files it writes and executes.** The Swift helpers are compiled from bundled sources into the extension's own storage. Three kinds of downloaded file are run, each behind a consent modal: the pinned `uv` release used to install the Python engines, which is the only download verified against a checksum (the SHA-256 the project publishes beside it, compared before unpacking, [src/platform/uvBootstrap.ts](../src/platform/uvBootstrap.ts)); the Python packages `uv` then installs from PyPI, trusted the way any dependency is; and the sherpa-onnx release the Kokoro setup unpacks into that storage, whose `sherpa-onnx-offline-tts` binary is spawned to synthesise ([src/setup/kokoroSetup.ts](../src/setup/kokoroSetup.ts)). The sherpa-onnx archives and the Piper voice files carry no checksum of their own, so they are trusted on the TLS connection to their release host. Voice models are data: Piper voices and the Kokoro model land in the extension's storage, and the Hugging Face libraries keep the neural checkpoints in their own cache (`$HF_HOME`, else `~/.cache/huggingface`).
- **Settings that name a program.** `claudeCodeTts.piper.path` is spawned, so it is machine-scoped (`"scope": "machine"`, as are `qwen3.runtime` and `chatterbox.runtime`): a repository cannot choose what the extension runs by shipping a `.vscode/settings.json`. The settings that name a voice, a model file or a rewrite of the text are listed under `capabilities.untrustedWorkspaces.restrictedConfigurations`, so in an untrusted workspace their values are ignored and the ones from user settings are used instead.
- **The control file.** `~/.claude/claude-code-tts-control` is read, never written, and only ever matched against a fixed list of words (`mute`, `skip`, `stop` and a few more). Nothing in it is executed and an unrecognised line is ignored ([src/session/control.ts](../src/session/control.ts)).
- **Voice profiles imported from a backup.** An import only accepts directories that contain a reference WAV and a JSON file, with slug validation, and copies them rather than overwriting ([src/voices/backup.ts](../src/voices/backup.ts)). No code is executed from a backup.
- **Hooks in `~/.claude/settings.json`.** Only entries pointing at the extension's own script are added or removed, and a backup is written before the first change. Completion sounds are on by default (`claudeCodeTts.notifications.enabled`), so the hooks are written on first activation and a one-time notice says what changed; "Toggle Completion Sounds" removes them again ([src/setup/notifySetup.ts](../src/setup/notifySetup.ts)). The installed script makes one write of its own: it deletes its own entries when it finds the extension uninstalled, because nothing on the editor side runs then (`assets/notify.js`).

## What is out of scope

Model weights downloaded from Hugging Face and the Python packages a user installs are third-party artifacts; verify them as you would any dependency. The extension pins the model identifiers it requests and loads cached snapshots offline afterwards.
