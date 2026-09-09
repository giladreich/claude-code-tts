# Claude Code TTS guide

Walkthroughs for the things worth doing once. The [README](../README.md) covers the first minute; the [reference](REFERENCE.md) has every setting.

## Pick an engine that sounds good

Run **Claude Code TTS: Choose Voice Engine**. Highlighting an engine says what it costs; choosing one that is not installed installs it, with progress, and switches to it when it is ready. **Claude Code TTS: Set Up the Best Voice** skips the choice: it installs whichever engine this machine and the languages you listen to point at, sets the idle unload time from the machine's memory where the engine keeps a model loaded, and goes on to making a voice when the engine is one that can.

**Kokoro** is the cheapest to install: one 360 MB download into the extension's own storage, no Python, 28 English voices, and it speaks faster than realtime. Then **Select Voice** browses them with a sample on every highlight. The engine picker marks Kokoro "(recommended)" only on a small machine (under 8 GB of memory, or at most two cores) that listens in languages it speaks; on anything larger it recommends Qwen3, which also speaks as a voice you make.

**Piper** suits a weak machine: one voice file at a time, 60-115 MB. Twelve curated voices are offered for download, covering six languages; any other Piper voice works if you put its `.onnx` and `.onnx.json` into the extension's `piper-voices` folder. Some voices are non-commercial. The confirmation that downloads a voice for a language names its licence; the **Download Piper Voice** picker shows only the size, so check the licence before you use one commercially.

**Qwen3** and **Chatterbox** are the two that speak in a voice you create. Qwen3 is faster and covers ten languages; Chatterbox covers 23, including many no other engine here speaks, and is the heavier of the two.

Nothing has to be installed first. If you have `uv`, the extension uses it. If not, the first setup downloads a pinned copy of `uv` (checked against the SHA-256 its project publishes) into the extension's storage, and installs the engine, a Python and its cache there. Nothing lands on your PATH or in a Python you own, and **Storage and Cleanup** removes the whole folder in one step.

## Make it your own voice

**Claude Code TTS: My Voices**, then one of:

**Record** shows a passage, listens for about ten seconds, and transcribes what you said locally to check it matches. A recording that does not match is flagged before it becomes a voice, because a reference whose transcript is wrong is what makes a cloned voice babble. macOS asks for microphone permission the first time.

**From a file** takes audio or video you already have. Name a part of it if the file is long, then pick from the clearest stretches between pauses: each one plays as you move through the list, you can name an exact range instead, and the back arrow returns to the part of the file, the stretch or the transcript. What is said in the stretch you keep is transcribed and shown for you to confirm.

**Design** needs no recording: pick a starter ("Warm American woman", "Calm American man") or describe what you want, and the VoiceDesign model renders a reference in about half a minute. Keep it or try again.

Before any of this you choose the voice's **language**. That sets its accent, not its reach: a reference recorded in one language still speaks the others through Chatterbox, with the accent of the one it was recorded in. When you design a voice for a language the designer cannot read, it renders the description on an English passage and then has Chatterbox re-record that voice reading the target language's own passage, so what gets stored is speech in the language the voice is for.

**My Voices** also refines one from a plain request ("a bit louder, warmer, slower"), renames, sets loudness and pace, corrects the reference text of a recorded voice (the words the cloner reads along with the recording; a wrong word there is heard in every sentence), and backs voices up to a file. Voices you create cannot be downloaded again: back them up before freeing disk space.

## Hear everything in one language

**Claude Code TTS: Languages and Translation**, then **Speak everything in one language**. Pick a language, confirm the model download (about 100 MB, once, per direction), and every message is translated locally before it is spoken.

Technical words stay in English: "commit", "build", "pull request" and the like, plus anything that looks like code (paths, identifiers, acronyms). The list is `keepInSourceLanguage`; setting your own replaces the built-in one.

To give one language its own voice instead, use **Set the voice for a language** in the same menu: answers in that language get their own voice, while everything else keeps yours.

## Using it with the CLI

Nothing to configure: `claude` in any terminal writes the same transcript files this extension reads, so its output is spoken as soon as it is written. That covers VSCode's integrated terminal, a native terminal, a tmux pane and a session over ssh into this machine.

Two things are worth knowing.

**A VSCode window has to be open.** This is a VSCode extension; the speech comes from it. The window does not have to have your project open, and it can be minimised, but if you close them all the speaking stops. Completion sounds keep working, because Claude Code triggers those itself.

**Several windows do not talk over each other.** Each window speaks the folders it has open. A session in a folder no window has open (the usual case for a terminal) is spoken by whichever window has been open longest, and only that one. Close it and the next takes over within a minute. **Check Setup** has a row saying whether this window or another one speaks terminal sessions, and how many windows are open. When a message comes from a session that is not this window's own project, the voice says which one it is before reading it.

**The controls are VSCode's, with one exception.** Mute, skip and speed are commands and keys there. When you are in a terminal and the speech should stop now, one line in a file does the same:

```bash
echo mute > ~/.claude/claude-code-tts-control     # and unmute, or toggle
echo skip > ~/.claude/claude-code-tts-control     # this sentence
echo stop > ~/.claude/claude-code-tts-control     # and drop the backlog
echo "rate 260" > ~/.claude/claude-code-tts-control
```

Also `pause`, `resume`, `repeat`, `faster`, `slower`. Every open window reads it, so muting mutes everywhere. Nothing else in that file does anything: a line the extension does not recognise is ignored, and it runs nothing.

An alias is worth having:

```bash
alias vmute='echo mute > ~/.claude/claude-code-tts-control'
```

To go back to only hearing this window's folders, use **Menu**, **Voice and speed**, and switch the "Speaking" row, or set `claudeCodeTts.listenTo` to `workspace`.

## Everyday use

- **Speak text from Claude's chat panel**: select it and press the Speak Selection key. In a chat panel or terminal, copy it first; VSCode does not let extensions read a panel's selection, so the copy is the bridge.
- **Switch voice while it talks**: pick another voice and the sentence restarts in it at once.
- **Keep it out of the way**: `onlyWhenUnfocused` speaks only while VSCode is in the background, `ignoredTools` silences noisy tools, and `listenTo` decides whether sessions outside this window's folders are spoken too.
- **Completion sounds**: **Menu**, then **Completion sounds**, installs Claude Code hooks so a sound plays when Claude finishes or needs you, even with VSCode closed. Each event gets its own sound, chosen by ear.

## What to install yourself

`ffmpeg` is the only thing worth installing yourself, apart from `espeak-ng` on Linux. `ffmpeg` brings Linux and Windows close to macOS: microphone cloning, importing formats the OS cannot decode, and speed and volume control during playback. Without `espeak-ng` the built-in system voice on Linux has nothing to speak with, and **Check Setup** reports the engine as missing with no button to fix it.

```bash
brew install ffmpeg            # macOS
sudo apt install ffmpeg        # Debian, Ubuntu
winget install Gyan.FFmpeg     # Windows
```

## Uninstalling

**Menu > Setup and diagnostics > Remove everything Claude Code TTS added** offers to back up your voices, then removes the completion-sound hooks under `~/.claude`, every model, runtime, helper and log it downloaded, and every `claudeCodeTts.*` setting, and tells you what it could not remove (Python tools installed with `uv`, which it does not own, with the command that removes them). Then uninstall from the Extensions view. Uninstalling without that step still removes the hooks, on the next start of VSCode; VSCode deletes the extension's storage folder then too, which is where your voices live, so back them up before uninstalling. Your settings stay in VSCode's settings.json, as every extension's do.

## When something is wrong

Start with **Claude Code TTS: Check Setup**. It reports what works on this machine and offers a button that fixes what does not.

| Symptom | Where to look |
|---|---|
| No sound at all | Is the status bar item muted? **Menu**, **Setup and diagnostics**, **Show spoken log**: are lines arriving? If not, check `listenTo`. |
| It speaks commands but skips the narration | A Claude Code limitation: mid-turn prose is often never written to the transcript. See the [reference](REFERENCE.md#what-gets-spoken-1). |
| Speech stutters | The spoken log mentions prebuffering. A big model on a busy machine cannot keep up with a fast rate; lower the rate or use a lighter engine. |
| A voice babbles | Its reference text must match its recording exactly. Re-record, and correct the transcript when it is shown. |
| Speech in some languages says the wrong words | Those writing systems need their vowel marks restored first: **Check Setup** says whether the text preparation is installed. |
| Disk full | **Storage and Cleanup** lists every model and cache with its size, and marks what is in use. |
| Anything else | **Menu**, **Setup and diagnostics**, **Open diagnostics folder**: `player.log` and the daemon logs live there. |
