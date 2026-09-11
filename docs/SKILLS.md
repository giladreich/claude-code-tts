# Skills: how to do the recurring jobs in this repo

## Add a speech engine
1. Create `src/tts/<name>.ts` returning a `Backend` (see `types.ts`). For synth-then-play engines wrap `synthesizeThenPlayBackend` and provide `synthesize`/`synthesizeStream` (a daemon) or `buildSynth` (CLI). Set `nativeSpeed` if the engine has a real speed knob, `typicalRtf` for prebuffering. Such an engine offers what it played to the export buffer by itself; an engine that plays its own way must call `reportPlayed` (`src/tts/played.ts`) once an utterance has finished, with the files it played or a way to render it again, and delete the files itself only when the report answers false (see `speakAndReport` in `src/tts/system.ts`).
2. Register it in `ENGINES` (`src/speech/speech.ts`), add the `engine` enum value and settings in `package.json` and every new setting key to `SETTING_KEYS` (`src/core/config.ts`, a contract test compares the two lists), a picker branch in `selectVoice` (`src/ui/voicePickers.ts`), and a chunk plan in `chunkPlanFor` (`src/core/config.ts`). Each new setting needs a row in the Settings table of [REFERENCE.md](REFERENCE.md) with its current default, and each new command a row in the Commands table with its current title; `test/unit/docs.test.js` fails on a missing or drifted row.
3. Tests: a protocol test against a fake model module (see `test/unit/daemons.test.js`) and, if it streams, a pipeline test with a fake `synthesizeStream` (`test/integration/synthPlay.test.js`).
4. `npm run verify` before it is done: format check, lint, compile, tests. `npm run format` and `npm run lint:fix` apply what can be applied. CI runs the format check and the linter before it compiles anything, and `vsce package` runs the same gate.

## Change the player protocol (`assets/wavplayer.swift`)
- Keep replies tagged with `id`; keep `node.stop()`/`pause()` outside the lock; bump `BIN_NAME` in `src/tts/audio.ts` and add the old name to the removal list. Run `test/integration/player.test.js` (race, pause, rate, error path).

## Measure latency and smoothness
- Transcript-write to first sound: write a fake `assistant` line into a temp project dir under `~/.claude/projects/` while a `SpeechQueue` with volume 1 is attached (see the e2e snippets in git history, or `test/integration`), then read `player.log`: `[node] play ...` timestamps vs the write time; `underrun` lines mean synthesis fell behind playback; `WATCHDOG` means a stuck stream.
- Daemon speed: `PyTtsDaemon.request(..., stream: true)` and time the first `part` and the total; RTF = wall / audio seconds.

## Voice cloning quality
- Reference: 6-12s of clean speech, silence-trimmed, transcript matching exactly (Whisper, user-confirmed). Longer references make the model babble; a mismatched transcript makes it speak the missing words first.
- Loudness/pace are profile settings (`gain`, `pace` in meta.json): `gain` is applied in the daemon by both engines, `pace` as tempo by Qwen3 only (`naturalWpm: 175 / pace`, `src/tts/qwen3.ts`) - Chatterbox declares a fixed natural pace and ignores it. Designed voices can be re-rendered from an amended description (My Voices > Refine with a request).
- Runaway generations are cut at `expected_seconds` (`assets/speech_budget.py`, shared by the daemons) in the MLX Qwen3 daemon and both Chatterbox daemons; the torch daemon `assets/qwen3_daemon.py` has no cutoff. The log line `{"runaway": true}` in `qwen3-daemon.log` or `chatterbox-daemon.log` shows how often.

## Debug "nothing is spoken"
1. Output channel "Claude Code TTS": are lines arriving? If not, check `claudeCodeTts.listenTo` (everywhere vs workspace), whether another window owns that session (Check Setup says), and that the session writes to `~/.claude/projects/`.
2. `player.log`: `play` without `done` -> player issue; `WATCHDOG` -> device stall (Bluetooth asleep?).
3. Daemon logs for tracebacks; `ready` timeouts mean a model load/download stalled (HF network).

## Release
Changelog section, version in `package.json` and the lockfile, `git tag 1.1.0`,
push. Setup and everything that can go wrong: [PUBLISHING.md](PUBLISHING.md).

## Change the icon
`assets/icon.svg` is the source; `assets/icon.png` beside it is what ships, and
`package.json` points at the PNG because the Marketplace does not accept SVG
(nor does it accept one in the README, which is why the README shows the PNG).
Edit the SVG, then re-export at 256x256, for example
`rsvg-convert -w 256 -h 256 assets/icon.svg -o assets/icon.png` (`brew install librsvg`).
The SVG does not ship.

## Add a window-coordinated behaviour
Anything that must happen once per machine rather than once per window goes
through `src/session/sessionOwnership.ts`: windows announce themselves in
`~/.claude/claude-code-tts-windows/` (its own `<globalStorage>/windows/` only
when there is no `~/.claude`, so VSCode and Insiders share one registry) and
the oldest live window holding that folder wins, or the oldest live window of
all when no window holds it. Test it with the injected clock and id
(`test/unit/sessionOwnership.test.js`) rather than with real timers.
