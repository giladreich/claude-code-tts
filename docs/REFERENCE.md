# Claude Code TTS reference

Everything the [README](../README.md) leaves out: every setting, every command, what each engine costs, and what works on which platform.

## Settings

Every setting is under `claudeCodeTts.` and can be changed in the Settings UI (search "Claude Code TTS"), where they appear in these same groups. Most have a picker that is easier than typing the value, and **Reset Settings to Defaults** restores all of them.

The advanced groups are engine internals. Nothing in the everyday groups depends on them, and their defaults are measured rather than guessed.

### Everyday

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (the status bar item opens the menu, whose first row mutes and unmutes). |
| `engine` | `system` | `system` = the OS voice, or one of the local neural engines: `kokoro`, `piper`, `qwen3`, `chatterbox`. |
| `rate` | `210` | Base speaking rate in words per minute (70-450). 210 is a natural pace, 280 brisk, 380 skimming. Piper reaches it with its own speed control, and the system voice with the OS engine's; Kokoro, Qwen3 and Chatterbox are time-stretched by the player without changing pitch, where the platform can do that (macOS always, elsewhere with ffplay or sox). Without such a player Kokoro falls back to its own speed control, and Qwen3 and Chatterbox cannot change pace at all. |
| `volume` | `100` | Speech volume, 0-100. |
| `speakText` | `true` | Speak prose messages. |
| `speakTools` | `true` | Announce tool calls. |
| `speakErrors` | `true` | Announce failed tool calls with a short error summary. |
| `listenTo` | `everywhere` | Which Claude Code sessions this window speaks. `everywhere` includes sessions you start with the `claude` command in any terminal, inside VSCode or outside it; `workspace` restricts it to the folders this window has open. |

### What Gets Spoken

| Setting | Default | Meaning |
|---|---|---|
| `speakSubagents` | `false` | Also speak subagent (sidechain) output. |
| `ignoredTools` | `[]` | Tool names never announced, e.g. `["Read", "Grep", "TodoWrite"]`. |
| `collapseToolSeconds` | `90` | Unchanged activity stays silent; after this many seconds one "Still ..." reminder plays (0 = never). |
| `interruptOnNew` | `false` | New prose cuts whatever is still being spoken. |
| `onlyWhenUnfocused` | `false` | Speak only while the VSCode window is unfocused. |
| `substitutions` | `{}` | Pronunciation replacements, e.g. `{"vsce": "V S C E"}`. |

### Languages

| Setting | Default | Meaning |
|---|---|---|
| `autoLanguage` | `true` | Detect each message's language and speak it accordingly (chunking, Qwen3's language, and the voice mapped below). |
| `speakLanguage` | `""` | Speak everything in this language, translating locally when the text is in another one. Empty speaks each message as written. |
| `languageVoices` | `{}` | Voice per language for the current engine, e.g. `{"de": "bf_emma"}`. Set it with "Set Voice for a Language". |
| `keepInSourceLanguage` | `[]` | Words to leave in the language they were written in rather than translate. Empty uses a built-in software glossary (commit, branch, build, deploy, endpoint, query and so on); your own list replaces it. Identifiers, paths, versions and ALL-CAPS acronyms are always left alone. |

### Sounds

| Setting | Default | Meaning |
|---|---|---|
| `notifications.enabled` | `true` | Completion sounds via Claude Code hooks. The hooks are written to `~/.claude/settings.json` the first time the extension runs, announced once, and removed by the hook script itself when it finds the extension uninstalled. |
| `notifications.sounds` | `{"done":"Glass","permission":"Funk","question":"Ping","waiting":"Purr"}` | Which sound plays for each event, by name from the system sound library. An event with no entry is silent, and installs no hook at all, so Claude Code starts nothing for it. Keys: `done` (Claude finished), `permission` (waiting for your approval), `question` (Claude asked you something), `waiting` (idle reminder), `tool` (a tool from `notifications.toolFilter` ran), `subagent`, `prompt`. Set these with **Claude Code TTS: Configure Notification Sounds**, which auditions each one. |
| `notifications.toolFilter` | `["Bash"]` | Which tools trigger that sound. |
| `notifications.volume` | `70` | Notification sound volume, 0-100. |

### Voices and Engines (advanced)

| Setting | Default | Meaning |
|---|---|---|
| `voice` | `""` | System-engine voice name; "Select Voice" browses with preview. Empty = OS default. |
| `piper.path` | `piper` | Piper executable (PATH name or absolute path). |
| `piper.voice` | `""` | Path to a Piper `.onnx` model; "Download Piper Voice" sets it for you. |
| `kokoro.voice` | `af_heart` | Kokoro speaker: 28 named voices, plus the rest of the model's 53 offered by number, all auditioned in "Select Voice". |
| `qwen3.voice` | `Ryan` | Qwen3 preset speaker, or `clone:<slug>` for a cloned or designed voice. |
| `qwen3.model` | `0.6B` | `0.6B` streams at ~0.7x realtime; `1.7B` is closer to a cloned reference but runs at ~1.0x realtime and buffers before each chunk. `1.7B` is slower than realtime on most machines (a 16 GB laptop was measured making 8.4 s of speech in 14.9 s), so with it the speaking rate cannot go past the voice's natural pace; `0.6B` runs ahead of realtime and can be sped up. Change it from the status bar: **Voice and speed** then **Voice model**, which also says which sizes are already downloaded. |
| `qwen3.style` | `Speak in a calm, natural, steady narration voice, articulating each word clearly, with natural pauses between sentences.` | Delivery instruction for Qwen3 **presets** (clones ignore it). Clear it for the model's own delivery. |
| `qwen3.runtime` | `auto` | `auto` prefers MLX on Apple Silicon, else PyTorch; force with `mlx` or `torch`. |
| `chatterbox.voice` | `default` | Voice for the Chatterbox engine: `clone:<slug>` for one of your own (the same profiles Qwen3 uses). The MLX runtime has no built-in speaker, so a voice profile is required there; `default` works only on the PyTorch runtime. |
| `chatterbox.runtime` | `auto` | Which runtime speaks Chatterbox: `auto` prefers MLX on Apple Silicon (measured 1.45x realtime, and the newer v3 weights), `torch` uses the extension's own virtualenv (2.4x realtime, v2 weights). |
| `voiceRates` | `{}` | Speaking rate per voice, in words per minute, keyed `engine:voice`. Written by **Speak Faster**, **Speak Slower** and **Set Speech Rate**: the pace you choose while listening to a voice belongs to that voice, so switching voices no longer means retuning by hand. A voice with no entry here speaks at `claudeCodeTts.rate`. |

### Performance (advanced)

| Setting | Default | Meaning |
|---|---|---|
| `dynamicRate` | `true` | Speed up when speech falls behind Claude, to about 35 percent above your rate. It starts only for a real backlog (three sentences or 600 characters waiting; two sentences is what any answer looks like while it is read), moves 4 percent of your rate per sentence up or down rather than jumping, never changes mid-sentence, and never asks for more than the engine can synthesize. |
| `pauseScale` | `1` | Length of the pauses between sentences, as a multiple of a natural reading pause. `0` runs sentences together, `1.5` is slow and deliberate. |
| `idleUnloadMinutes` | `45` | Minutes without speech after which the Qwen3 or Chatterbox model is unloaded (0 keeps it resident). A loaded model holds 1.5-3 GB; the first sentence after an unload costs a measured 27 s for Chatterbox (16 s to load, 11 s to speak). **Set Up the Best Voice** lowers this to 10 on a machine with less than 16 GB and raises it to 90 at 32 GB or more, unless you have set it yourself. |


## Commands

Fifteen commands are listed in the palette; the others stay registered so that keybindings and scripts keep working, and are reached through the flow that owns them.

| Command id | Title |
|---|---|
| `setupBestVoice` | Set Up the Best Voice |
| `checkSetup` | Check Setup |
| `languageVoice` | Set Voice for a Language |
| `toggle` | Toggle Speech |
| `stop` | Stop Speaking |
| `skip` | Skip Current Utterance |
| `rateUp` | Speak Faster |
| `rateDown` | Speak Slower |
| `selectVoice` | Select Voice |
| `selectRate` | Set Speech Rate |
| `repeatLast` | Repeat Last Message |
| `speakSelection` | Speak Selection (from the editor or clipboard) |
| `speakClipboard` | Speak Clipboard |
| `pauseResume` | Pause or Resume |
| `history` | Recent Messages |
| `menu` | Menu |
| `resetSettings` | Reset Settings to Defaults |
| `removeEverything` | Remove Everything Claude Code TTS Added |
| `selectEngine` | Choose Voice Engine |
| `downloadVoice` | Download Piper Voice |
| `setupKokoro` | Set Up Kokoro Engine |
| `setupQwen3` | Set Up Qwen3 Engine |
| `setupChatterbox` | Set Up Chatterbox Engine |
| `setupTranslation` | Set Up Translation |
| `toggleNotifications` | Toggle Completion Sounds |
| `configureSounds` | Configure Notification Sounds |
| `manageVoices` | My Voices |
| `designVoice` | Design a Voice from a Description |
| `cloneVoice` | Clone My Voice |
| `cloneVoiceFromFile` | Clone Voice from an Audio or Video File |
| `storage` | Storage and Cleanup |
| `exportVoices` | Back Up Voices to a File |
| `importVoices` | Import Voices from a File |
| `showLog` | Show Spoken Log |
| `speak` | Speak Selection |
| `languages` | Languages and Translation |

## What gets spoken

Everything Claude writes reaches you through the session transcript Claude Code saves to disk. Tool calls and the final message of a turn are always persisted, so "Bash: install dependencies" and Claude's closing summary are always spoken. The prose Claude writes *between* tool calls is a different story: in the VSCode Claude Code panel, a large share of those mid-turn paragraphs are never written to the transcript at all (measured in one long session: only 114 of 288 tool-calling messages had their preceding prose saved). Claude Code TTS reads every text block that exists; it cannot read what the harness never saved. If you notice the voice announcing commands without the narration before them, that is the cause, and it is worth reporting to the Claude Code team. The output channel ("Show spoken log") lists exactly what was received.


Also never spoken: code blocks and fenced snippets, tables, horizontal rules, URLs (the link text is read, the target is not), and any tool named in `ignoredTools`. Paths are read as their last segment, so `/Users/me/proj/src/extension.ts` is spoken as "extension.ts".

## Speaking rate

`rate` is the default pace, in words per minute. The rate you then set while
listening to a particular voice is remembered **for that voice** (in
`voiceRates`), because a pace that suits one voice is uncomfortable on
another: a preset that already talks quickly and a slow cloned voice do not
want the same number. Switch voices and the new one starts at the default;
switch back and yours returns.

Three things set it: **Speak Faster** and **Speak Slower** (8 percent a
press, applied to the sentence already playing) and **Set Speech Rate**,
which auditions each rate before you commit.

Dynamic catch-up speeds up when speech falls behind Claude, to about 35
percent above your rate, between chunks and never mid-sentence, and never
past what the engine can actually produce.

## Controlling it from a terminal

Writing one line to `~/.claude/claude-code-tts-control` does what the matching
command does, for people working in a terminal rather than in VSCode:

| Line | Effect |
|---|---|
| `mute`, `unmute`, `toggle` | The master switch. Muting stops what is playing and drops the queue. |
| `pause`, `resume` | Freeze mid-word, keeping the backlog. |
| `skip` | Cut the sentence being spoken. |
| `stop` | Silence now, stay enabled. |
| `repeat` | Speak Claude's last message again. |
| `faster`, `slower` | 8 percent, remembered for the voice in use. |
| `rate <number>`, `speed <number>` | A rate in words per minute, remembered for the voice in use. |

Every open window reads the file, so a mute applies to all of them. The file
is only ever read: nothing is written back, nothing is executed, and a line
that is not one of these is ignored. A line left in the file is not obeyed
again when a window starts.

## Sizes and speeds

| What | Size | Speed |
|---|---|---|
| System voice | 0 | instant |
| Kokoro runtime and model | 360 MB | first words in about half a second; faster than realtime |
| Piper voice | 60-115 MB each | faster than realtime |
| Qwen3 0.6B | 2.3 GB | about 0.7x realtime on Apple Silicon (MLX), streamed |
| Qwen3 1.7B | 4.2 GB | about 1.0x realtime, closer to the reference |
| Qwen3 VoiceDesign | 4.2 GB | only while designing a voice |
| Chatterbox (MLX) | 3.0 GB | first words in about 2.5 s; whole chunks at 0.6-0.7x realtime |
| Chatterbox (PyTorch) | 2.5 GB plus a 1 GB virtualenv | about 2.4x slower than realtime |
| Whisper (checks a clone recording) | 485 MB (967 MB on torch) | once per recording |
| Translation model | about 100 MB per direction | offline after the download |

**Storage and Cleanup** shows what is actually on this machine, marks what the current settings need, and frees the rest. Models are downloaded again on next use; voices you created are not, so they are never part of a bulk free.

Memory: a neural engine holds its model resident while it is speaking and for `idleUnloadMinutes` afterwards (45 by default), then releases it and reloads on the next sentence. Chatterbox is the heaviest at about 3 GB.

Speed: no engine can be heard faster than it synthesizes, and Qwen3 on Apple Silicon synthesizes at roughly realtime. Running several generations at once does not help: measured on a 16 GB laptop, one, two and three daemons all produced about 0.57x realtime in total, each stream slowing by exactly the number of streams, because a single generation already saturates the GPU. Quantized checkpoints (8-bit, 4-bit) measured no faster than bf16. So the speaking rate for Qwen3 tops out near the voice's natural pace on such machines, and the status bar says so; Kokoro and the system voice synthesize many times faster than realtime and speak at any rate.

## Text preparation

Some writing systems leave out the vowel marks, so a speech model has to guess them and ends up saying different words. The Chatterbox daemon restores them before it generates, which costs about 47 ms a sentence.

Measured by transcribing the output back with whisper-large-v3-turbo, 24 generations of the same sentences in one such language:

| | Character error | Word error |
|---|---|---|
| Chatterbox, vowel marks restored | 0.076 | 0.194 |
| Chatterbox, without them | 0.294 | 0.683 |
| A Piper voice for that language | 0.117 | 0.299 |
| The system voice for that language | 0.052 | 0.158 |

The system voice is slightly more accurate and needs no download, so it is the fallback when Chatterbox is not set up. Chatterbox is the way to hear these languages in a voice you created rather than a stranger's.

**Check Setup** reports whether the text preparation is installed, since a runtime set up before it was added will not have it.

### Terms kept in the source language

Technical words are hidden behind placeholders while the sentence is translated, then put back, so "commit" is not read as a moral commitment. Not every translation model can carry them: measured over twelve technical sentences per direction, one model returned ten of them either copied back in English or with the terms silently deleted, while the same sentences with only identifiers hidden translated cleanly.

So the result is checked rather than trusted. A sentence handed back exactly as it was sent, or one missing placeholders, drops the glossary for that direction (identifiers stay hidden, because a translated identifier is simply wrong) and the paragraph is asked for again; a sentence that still comes back untranslated is retried on its own, and only then spoken as it was written. The log says once per direction when this happens, so a paragraph is never read half in one language and half in another.

## Platform support

Everything core works on macOS, Linux and Windows: transcript tailing, text handling, all five engines, the queue and its controls, settings and notification sounds. The differences are in audio playback and in the two macOS-only capture helpers.

| Capability | macOS | Linux | Windows |
|---|---|---|---|
| System voice (`say` / `espeak-ng` / `System.Speech`) | yes | yes | yes |
| Kokoro, Piper, Qwen3, Chatterbox engines | yes | yes | yes (Qwen3 needs `qwen-tts` and Chatterbox its own virtualenv; MLX is Apple-only) |
| Gapless streaming playback, first audio in ~0.5s | yes (bundled player) | no: audio plays per utterance | no: per utterance |
| Pitch-preserving rate and live rate change | yes | with `ffplay` or `sox` installed | with `ffplay` (from ffmpeg) |
| Rate without any of those | yes | Kokoro and Piper hit the rate natively; Qwen3 and Chatterbox cannot | same |
| Volume control | yes | with `ffplay`, `sox` or `paplay` | with `ffplay` (from ffmpeg); otherwise system volume |
| Pause mid-word | yes | yes | no (finishes the utterance, then holds) |
| Clone from the microphone | yes | yes, with `ffmpeg` (PulseAudio or ALSA) | yes, with `ffmpeg` (you pick the input device) |
| Clone from an audio or video file | yes | yes, with `ffmpeg` installed | yes, with `ffmpeg` installed |
| Design a voice from a description | yes | yes | yes |
| Completion sounds (hooks) | yes, per-event sound choice | yes, per-event choice from the desktop sound themes | yes, per-event choice from `C:\Windows\Media` |

Run **Claude Code TTS: Check Setup** to see which of these apply on your machine; a Python tool it lists as missing installs from right there. Installing `ffmpeg` is the one step that brings Linux and Windows close to parity, and the only one the extension asks you to run yourself (it needs your package manager): the prompt opens a terminal with the command typed for you to confirm.

**Nothing to install first.** Every neural engine except Kokoro is a Python package, and Kokoro downloads its own runtime. When you have `uv`, the extension uses it and your tool directory stays yours. When you do not, the first setup downloads a private copy of `uv` (a pinned release, verified against the SHA-256 its project publishes) into the extension's storage and installs the engine, a Python and its cache there: nothing lands on your PATH, in `~/.local`, or in a Python you own, and "Storage and Cleanup" removes the whole folder in one step. The pip fallback is gone: it wrote into your own Python, which PEP 668 distributions refuse.

**Why a Swift helper on macOS.** The premium playback path needs four things at once: keep the audio device open (spawning `afplay` per sentence costs about 1.2s each time), append audio parts while earlier ones are still playing (that is what makes streaming synthesis audible early), change speed mid-sentence without changing pitch, and recover when the output device changes. Node.js has no audio API, and the portable way to get one is a native addon, which would mean shipping binaries built against VSCode's exact Electron ABI for every platform. Instead the extension ships about 210 lines of Swift source and compiles them once with the toolchain macOS users already have; no binaries are distributed. Where that is unavailable (including macOS without the CommandLineTools), playback falls back to the platform player: `afplay` on macOS, and elsewhere `ffplay` first, then PowerShell's `SoundPlayer` on Windows, `sox`, `paplay` or `aplay`. Equivalent helpers for Windows (WASAPI) and Linux (PulseAudio/PipeWire) are possible with the same approach and are the natural next step for parity.


## Licences

The extension is MIT. The models and voices it can download are not all under the same terms, and the download prompt states each one before it starts:

- **Kokoro** (Apache-2.0) and its sherpa-onnx runtime (Apache-2.0).
- **Qwen3-TTS** (Apache-2.0).
- **Chatterbox Multilingual** (MIT), with Nakdimon (MIT) for restoring vowel marks.
- **Piper voices**: per voice. Several are non-commercial, and the picker says which before downloading.
- **Argos translation models**: per language pair, mostly CC-BY-SA.
- **Whisper** (MIT), used locally to check a clone recording.
