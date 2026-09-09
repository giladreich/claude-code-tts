# Contributing to Claude Code TTS

Thanks for looking. This is a small, dependency-free extension with an unusual shape: TypeScript that orchestrates local speech engines through child processes. The notes below get you productive quickly.

## Ground rules the code follows

1. **Everything stays on the machine.** No telemetry, no cloud TTS, no runtime npm dependencies. The only network calls are user-initiated model downloads ([PRIVACY.md](PRIVACY.md)).
2. **Every platform gets a working path.** A feature may be better on one platform, but it must degrade with a clear message elsewhere, and "Check Setup" must tell the user how to close the gap. See the platform table in [REFERENCE.md](REFERENCE.md#platform-support).
3. **Nothing blocks activation.** No synchronous Python imports or process probes at startup; check the filesystem instead.
4. **Tests are silent and offline.** Audio tests play at volume 0, engines are faked (`test/unit/daemons.test.js` runs the real daemon scripts against fake model modules on `PYTHONPATH`).
5. **ASCII punctuation, comments explain why, no emoji in code or docs.**
6. **No file in `src/` passes 1000 lines, and questions are asked one way.** `test/unit/contract.test.js` fails on both: a file over the limit has stopped being about one thing, so split it by responsibility rather than raising the limit, and `window.showQuickPick`/`showInputBox` cannot carry a back button, so every list and every prompt goes through the wrappers in `src/ui/prompts.ts`.

## Getting set up

```bash
npm install
npm run verify       # what CI runs: format check, lint, compile, tests
npm run format       # apply the layout (Prettier decides it, not you)
npm run lint:fix     # apply what the linter can fix on its own
npm run compile      # tsc to out/
npm test             # unit + integration + activation smoke (~90s; compile first, the tests load out/)
npm run test:unit    # unit only, no audio device needed
npx vsce package     # runs the checks and the suite, then builds the .vsix
code --install-extension claude-code-tts-<version>.vsix
```

`npm run verify` is the same gate a pull request goes through, so a branch that
passes it locally passes the checks. Packaging runs it too: an unformatted or
unlinted tree cannot be built into a `.vsix`.

Reload every VSCode window after installing: each window keeps the version it started with.

## What the checks are

Every pull request, and every push to `main`, runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):
format and lint first (seconds, nothing installed), then compile and unit tests on
Linux and Windows, the player, extraction and pipeline tests on macOS (that job is
`continue-on-error`, because hosted macOS runners may have no audio device, and the
packaging job does not wait for it), and a packaged `.vsix` as an artifact. The
rules themselves live in `.prettierrc.json` (layout) and `eslint.config.mjs`
(what may be written); where a hand-made grouping carries meaning, the literal
is marked `// prettier-ignore` and says why.

## Where things are

[ARCHITECTURE.md](ARCHITECTURE.md) has the diagrams and the module map. `src/` is one directory per concern, with `extension.ts` at the root doing the wiring: `core/` (the runtime singletons, `config()`, settings migration), `session/` (transcript tailing, window ownership, the control file, selection), `speech/` (line to utterances to queue), `tts/` (the engines and the synth-then-play machinery), `language/` (detection, glossary, translation), `platform/` (OS, disk, downloads, uv), `setup/` (the guided installs and Check Setup), `voices/` (clone, design, profiles, backup) and `ui/` (menus, pickers, status bar). There are no barrel files: every import names the module it needs. The short version:

| You want to change | Look at |
|---|---|
| What is spoken, chunking, tool announcements | `src/speech/format.ts` |
| Queue behaviour: skip, pause, previews, catch-up | `src/speech/speech.ts` |
| A speech engine | `src/tts/<engine>.ts` plus one row in the `ENGINES` table |
| Playback, streaming, prebuffering | `src/tts/synthPlay.ts`, `src/tts/audio.ts`, `assets/wavplayer.swift` |
| Voice cloning, design, management | `src/voices/clone.ts`, `src/voices/design.ts`, `src/ui/voiceManager.ts` |
| Commands: registration and wiring | `src/extension.ts` (flows live in their own modules) |
| A setting | `package.json` (`contributes.configuration`), `src/core/config.ts` (`config()`, `SETTING_KEYS`), `docs/REFERENCE.md` |
| Pickers, menus, prompts | `src/ui/prompts.ts` (every question), `src/ui/voicePickers.ts`, `src/ui/menus.ts` |
| Platform differences | `src/platform/platform.ts`, `src/setup/diagnostics.ts` |

[SKILLS.md](SKILLS.md) has step-by-step procedures: adding an engine, changing the player protocol, measuring latency, debugging silence, releasing.

## Working on audio

Audio bugs are measured, not guessed:

- `player.log` in the extension's storage ("Open diagnostics folder") records every playback with expected and actual duration, `underrun` when synthesis fell behind, `WATCHDOG` when a stream stalled.
- The output channel logs prebuffering decisions and which copy route "Speak Selection" used (`src/session/selection.ts`).
- For latency work, write a fake transcript line into a temp project under `~/.claude/projects/` and time the first `[node] play` entry against the write (see SKILLS.md).

State the numbers in the PR. "Sounds better" is not reviewable; "first audio 0.8s to 0.5s, no underruns over three chunks" is.

## Adding a setting or command

Both are enforced by tests. `test/unit/docs.test.js` fails if a setting is missing from the settings table in [REFERENCE.md](REFERENCE.md#settings) or its documented default no longer matches `package.json`, and if a command has no row in the commands table there under its current title. `test/unit/contract.test.js` fails if a new setting is missing from `SETTING_KEYS` in `src/core/config.ts` (reset-to-defaults walks that list), if a `get()` fallback differs from the schema default, or if a command hidden from the palette is offered nowhere else (a menu row, another flow, or `LEGACY_COMMANDS` in `src/core/commandCatalogue.ts`). Renaming or removing a setting needs an entry in `src/core/settingsMigration.ts`, or users silently lose the value. Add all of it in the same commit.

## Releasing

1. Update `CHANGELOG.md` (top entry, user-facing) and the version in `package.json`.
2. `npm run verify`, then install the packaged `.vsix` and try the change in a real session.
3. Push a tag `<version>`, with no prefix (`1.1.0`), and the release workflow does the rest. [PUBLISHING.md](PUBLISHING.md) is the one place the whole procedure is written down, setup included.

## Voice cloning changes

Cloning is the one area with a policy attached: [RESPONSIBLE-USE.md](RESPONSIBLE-USE.md). Changes there must keep the consent step, keep everything local, and keep deletion recoverable.

## Code of conduct

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).
