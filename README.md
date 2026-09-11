<!-- github-only: the Marketplace draws the icon in its own header -->
<p align="center">
  <img src="assets/icon.png" alt="" width="128" height="128">
</p>
<!-- /github-only -->

<h1 align="center">Claude Code TTS</h1>

**Hear Claude Code work.** Claude's replies are read aloud and its actions announced ("Bash: install dependencies", "Editing extension.ts"), so you can follow a long task without watching the screen.

Everything runs on your machine. No cloud speech, no telemetry, no accounts, no API keys.

## What you get

- **It just starts.** Install, and the next reply is spoken with a system voice. No setup, no key, no configuration.
- **Voices worth listening to.** Four local neural engines, installed from inside the extension when you want one.
- **Your own voice.** Record ten seconds, use a file you already have, or describe the voice you want and have it made.
- **23 languages** in a voice you create, and translation of everything into the one you prefer.
- **Prose only.** Code blocks, tables and URLs are never read out; tool calls become short announcements.
- **Export what you heard.** The last message, or any part of what was played, as an MP3 or another file, in the voice and language you listened in.

## How it works

Two things happen when Claude Code finishes a thought, and only one of them is this extension.

![Claude Code writes a transcript file and fires hook events. The extension reads the new lines, prose and tool calls but never code, and speaks them in your voice, speed and language. It also writes the hook entries once and picks a sound per event, after which Claude Code runs the notify script itself. Both reach your speakers.](assets/diagrams/how-it-works.png)

The alerts are Claude Code's, not the extension's: the extension writes the hook entries into `~/.claude/settings.json` once, and after that a small script plays the sound, so alerts still work with VSCode closed. Speech is the extension's own job: it tails the transcript file the agent has already written, so it adds no traffic and never talks to Claude Code.

Nothing is downloaded until you ask for something that needs it, and each engine is a local model that runs on your machine.

![Installing downloads nothing and speaks with the system voice. Wanting a natural voice adds Kokoro at 360 MB or Qwen3-TTS at 2.3 GB. Wanting your own voice adds Qwen3-TTS, Whisper at 485 MB to check what you read, and Chatterbox at 3 GB for a language Qwen3 cannot say. Wanting everything in one language adds Argos Translate at 100 MB per language pair.](assets/diagrams/what-downloads.png)

A voice you record or design is one file both cloning engines can speak, so the language you listen in decides the engine, not the voice. Six URLs exist in the whole source tree, four downloads and two documentation links you click yourself, listed in [PRIVACY.md](docs/PRIVACY.md) with the command that proves it.

**Built with** TypeScript on the VSCode extension host, no runtime npm dependencies. The engines are other people's work, run locally: [Piper](https://github.com/OHF-Voice/piper1-gpl), [Kokoro](https://github.com/k2-fsa/sherpa-onnx) through sherpa-onnx, [Qwen3-TTS](https://huggingface.co/Qwen) and [Chatterbox](https://github.com/resemble-ai/chatterbox) through Python (MLX on Apple Silicon, PyTorch elsewhere), [Whisper](https://github.com/openai/whisper), [Argos Translate](https://github.com/argosopentech/argos-translate). Python tools install with [uv](https://github.com/astral-sh/uv) into the extension's own storage; playback is a Swift helper on macOS, ffplay or sox elsewhere.

## Sixty seconds

1. Install the extension and open a folder where you use Claude Code.
2. Ask Claude something. You will hear the answer in your system voice, and a speaker item appears in the status bar.
3. Want a real voice? Click that item and choose **Set up the best voice**. One guided install, and Claude can then speak as a voice you record or design.

`ctrl+alt+v` mutes and unmutes (`ctrl+shift+alt+v` on Windows and Linux). Everything else is behind the status bar item.

## Voices

| Engine | Sounds like | Download | Notes |
|---|---|---|---|
| **System** | a computer | none | Built into macOS, Windows and Linux (espeak). Instant, always available. |
| **Kokoro** | a person, and fast | 360 MB once | Fast fixed voices. One guided download, no Python. 28 voices. |
| **Piper** | clear and light | 60-115 MB per voice | Good on weak hardware. One voice file at a time, 30+ languages. |
| **Qwen3** | expressive | 2.3 GB | **The one to install.** Ten languages, and it speaks as a voice you create. Faster than realtime on Apple Silicon. |
| **Chatterbox** | your voice, anywhere | 3 GB | Install this one instead when you listen in a language Qwen3 does not speak: 23 of them, in a voice you create. Heaviest, slowest to start. |

**Select Voice** speaks a sample as you move through the list, so you choose by ear.

## Your own voice

**My Voices** creates one three ways, all local:

- **Record** about ten seconds of a passage shown on screen. It checks that what you read matches before saving.
- **From a file** takes audio or video you already have, offers the clearest stretches to listen to (or an exact range you name), and transcribes the one you keep for you to confirm.
- **Design** builds a voice from a description ("a calm, low-pitched narrator") with no recording at all.

A voice is one profile that both Qwen3 and Chatterbox can speak, in every language that engine supports. Clone only your own voice, or one whose owner agreed: [responsible use](docs/RESPONSIBLE-USE.md).

## Other languages

Make a voice for a language and the rest follows from one question. Designing or choosing a voice built for another language offers to read everything in that language with it: the engine that pronounces it, translation into it, and anything either of those still has to download, in one confirmation with a progress bar per download. Answering no just uses the voice.

Claude switching language mid-session switches the voice with it. Beyond that, **Languages and Translation** does two things:

- **Speak everything in one language.** Sixteen languages, translated locally (about 100 MB per direction, offline afterwards). Technical words stay in English, because that is how developers say them.
- **Give one language its own voice.** An answer in another language is read by a voice for that language, while everything else keeps yours.

Some writing systems leave the vowels out, which is why speech models often say the wrong words in them. Chatterbox restores the vowel marks before speaking, which is the difference between unintelligible and accurate ([the measurements](docs/REFERENCE.md#text-preparation)).

## Entirely local

Nothing it reads or says is sent anywhere: not the text, not your recordings, not your voices, not your settings. Claude Code itself talks to Anthropic; that is the agent, not this extension.

## It follows the CLI too

Claude Code writes the same transcripts wherever it runs, so a session you start with `claude` in a native terminal, in VSCode's terminal, or over ssh is spoken like any other. A VSCode window has to be open, since this is a VSCode extension, but it does not have to be the folder you are working in.

With several windows open, each speaks its own folders and the one open longest speaks everything else, so a terminal session is heard once rather than three times. **Check Setup** says which window is doing it.

Completion sounds are the exception that needs nothing open: they run from Claude Code's own hooks.

The controls stay in VSCode, except the one you want most from a terminal: `echo mute > ~/.claude/claude-code-tts-control` (also `skip`, `stop`, `pause`, `resume`, `repeat`, `faster`, `slower`, `rate 260`).

Set `claudeCodeTts.listenTo` to `workspace` if you would rather a window only spoke the folders it has open.

## Requirements

- **Claude Code**: this extension speaks what it writes.
- **VSCode 1.85** or newer, on macOS, Windows or Linux.
- Nothing else. Linux needs `espeak-ng` for the system voice; every neural engine installs itself from inside the extension. On Windows and Linux the neural engines play through whatever WAV player is installed, so speed and volume control want `ffplay` (from ffmpeg) or `sox`: [platform support](docs/REFERENCE.md#platform-support) says what works without them.

## Shortcuts and commands

Seven keys are bound by default. On macOS they are `ctrl+alt`; on Windows and Linux `ctrl+shift+alt`, because `ctrl+alt` is AltGr on most layouts there.

| macOS | Windows / Linux | Command |
|---|---|---|
| `ctrl+alt+v` | `ctrl+shift+alt+v` | Toggle Speech |
| `ctrl+alt+p` | `ctrl+shift+alt+p` | Pause or Resume |
| `ctrl+alt+n` | `ctrl+shift+alt+n` | Skip Current Utterance |
| `ctrl+alt+s` | `ctrl+shift+alt+s` | Speak Selection |
| `ctrl+alt+r` | `ctrl+shift+alt+r` | Repeat Last Message |
| `ctrl+alt+=` | `ctrl+shift+alt+=` | Speak Faster |
| `ctrl+alt+-` | `ctrl+shift+alt+-` | Speak Slower |

The speed you set belongs to the voice you set it on. Switch voices and the new one speaks at your default rate; switch back and it is as you left it.

The rest are in the status bar menu; all but the last are in the command palette under "Claude Code TTS" too:

| Command | What it does |
|---|---|
| Menu | Mute, pause, and the five doors below. Shows the current engine, voice and speed. |
| Stop Speaking | Silence now, stay enabled for future output. |
| Recent Messages | Pick any of the last 20 messages to hear again. |
| Export Spoken Audio to a File | The last message, or any part of what was played, as an MP3 or another file, the way it was heard. |
| Select Voice | Browse the current engine's voices, with a preview on every highlight. |
| Set Speech Rate | Pick a speaking rate, auditioned before you commit. |
| Choose Voice Engine | Pick an engine, and install it from the same place if it is missing. |
| My Voices | Record, design, rename, fix the reference text, back up and restore your voices. |
| Languages and Translation | Speak everything in one language, or give one language its own voice. |
| Check Setup | What works on this machine, with a button that fixes what does not. |
| Storage and Cleanup | What the engines have downloaded, what the current settings still need, and one step to free the rest. Behind **Menu**, then **Setup and diagnostics**. |

## Settings

The everyday ones are the engine, the rate, the volume and what gets spoken. They are in the Settings UI under "Claude Code TTS", in the same groups as the documentation.

Full table, advanced groups included: [docs/REFERENCE.md](docs/REFERENCE.md#settings).

## Completion sounds

**Menu**, then **Completion sounds**, picks the sound for each event and auditions it as you move through the list. An event you give no sound installs no hook at all, and uninstalling the extension removes the ones it wrote.

## Known limitation

Claude Code often does not write mid-turn prose to its transcript, so a long turn can be quiet until it ends. That is Claude Code's behaviour rather than something this extension can fix; the [reference](docs/REFERENCE.md#what-gets-spoken) says what is available and what is not.

## More

- [Guide](docs/GUIDE.md): set up an engine, create a voice, translation, troubleshooting
- [Reference](docs/REFERENCE.md): every setting and command, sizes, speeds, platform support
- [Privacy](docs/PRIVACY.md): what never leaves the machine, and every network call
- [Responsible use](docs/RESPONSIBLE-USE.md): voice cloning, consent, disclosure
- [Architecture](docs/ARCHITECTURE.md): how it works inside
- [Contributing](docs/CONTRIBUTING.md): build from source, run the tests

MIT licensed. Model and voice licences are listed in the [reference](docs/REFERENCE.md#licences).
