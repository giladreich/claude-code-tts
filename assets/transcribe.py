# Transcribe a mono 16-bit WAV with Whisper. Used once per voice-clone
# reference so the transcript matches what was actually said. Prints one JSON
# line: {"text": "..."} or {"error": "..."}. Local only; the weights download
# from Hugging Face on first use.
#
#   transcribe.py <file.wav> [language-code]
#   transcribe.py --plan [language-code]   -> {"backend", "model", "mb"}
#
# Two backends, because the Python that runs this is whichever engine venv
# exists. The mlx-audio tool (Apple Silicon, and the only Python present on a
# machine set up for MLX) has no torch, so the transformers pipeline there
# fails with "PyTorch was not found" and the clone flow fell back to asking
# the user to type the transcript. MLX weights run in that env instead.
#
# English uses the English-only model; any other language needs the
# multilingual one, and is told which language to expect (an English-only
# model transcribing German returns nonsense, which then becomes a mismatched
# reference transcript and makes the cloned voice babble).
import contextlib
import importlib.util
import json
import re
import sys
import wave

# The repo to fetch and the megabytes it costs on first use. The MLX repos
# must be the "-asr-" conversions: the older mlx-community/whisper-*-mlx
# repos hold weights alone, and mlx-audio then loads no tokenizer at all
# ("Processor not found"); borrowing OpenAI's tokenizer loads but decodes
# invented words in the middle of the audio.
MODELS = {
    "mlx": {
        "en": ("mlx-community/whisper-small.en-asr-fp16", 485),
        "other": ("mlx-community/whisper-small-asr-fp16", 486),
    },
    "torch": {
        "en": ("openai/whisper-small.en", 967),
        "other": ("openai/whisper-small", 967),
    },
}


def backend():
    """MLX where it is installed, transformers with torch otherwise."""
    if importlib.util.find_spec("mlx") and importlib.util.find_spec("mlx_audio"):
        return "mlx"
    if importlib.util.find_spec("torch"):
        return "torch"
    return None


def plan(language):
    kind = backend()
    if not kind:
        return {"error": "no speech-recognition runtime in this Python"}
    model, mb = MODELS[kind]["en" if language == "en" else "other"]
    return {"backend": kind, "model": model, "mb": mb}


def duration(path):
    with contextlib.closing(wave.open(path, "rb")) as w:
        return w.getnframes() / float(w.getframerate())


def speech_end(path):
    """When the speech stops, in seconds, or None if that cannot be measured.

    The same 20ms frames and threshold as trimSilence in src/tts/wav.ts, which
    is what prepared this file: it keeps 200ms of tail, and Whisper fills
    silence with words it was never given ("Thank you." is the famous one).
    """
    try:
        import numpy as np

        with contextlib.closing(wave.open(path, "rb")) as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                return None
            rate = w.getframerate()
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
        frame = max(1, int(rate * 0.02))
        usable = (pcm.size // frame) * frame
        if usable == 0:
            return None
        magnitude = np.abs(pcm[:usable]).reshape(-1, frame).mean(axis=1)
        rms = float(np.sqrt((pcm[:usable] ** 2).mean()))
        loud = np.flatnonzero(magnitude > max(150.0, rms * 0.15))
        return float((loud[-1] + 1) * frame / rate) if loud.size else None
    except Exception:
        return None


def spoken_text(segments, seconds):
    """The segments that cover the speech, in order.

    Whisper pads its input to 30 seconds and mlx-audio keeps decoding into the
    padding: a 3.8s recording came back as its own sentence followed by 31
    segments of repetition and invented words. Everything from the first
    segment that starts at or after the last speech is that, so stop there,
    drop what decoded to punctuation alone, and drop a segment that only
    repeats the one before it (the other shape a runaway takes).
    """
    parts = []
    for s in segments:
        start = s.get("start")
        if start is None or start >= seconds:
            break
        text = str(s.get("text", "")).strip()
        if not re.search(r"\w", text):
            continue
        if parts and text.strip(".,!?").lower() == parts[-1].strip(".,!?").lower():
            continue
        parts.append(text)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def transcribe_mlx(path, language):
    import mlx_audio.stt as stt

    model, _ = MODELS["mlx"]["en" if language == "en" else "other"]
    m = stt.load(model)
    # A scalar temperature, not Whisper's default ladder: the ladder falls
    # back to sampling when a window decodes repetitively, which the padded
    # silence after a short reference always does, and every run then invented
    # a different tail. Greedy decoding is deterministic and stops sooner.
    options = {"temperature": 0.0, "condition_on_previous_text": False}
    if language != "en":
        options["language"] = language
        options["task"] = "transcribe"
    out = m.generate(path, **options)
    return spoken_text(out.segments, speech_end(path) or duration(path)), model


def transcribe_torch(path, language):
    import numpy as np
    from transformers import pipeline

    model, _ = MODELS["torch"]["en" if language == "en" else "other"]
    with contextlib.closing(wave.open(path, "rb")) as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    asr = pipeline("automatic-speech-recognition", model=model, device="cpu")
    kwargs = {} if language == "en" else {"generate_kwargs": {"language": language, "task": "transcribe"}}
    result = asr({"raw": pcm, "sampling_rate": sr}, chunk_length_s=30, **kwargs)
    return str(result["text"]).strip(), model


try:
    language = (sys.argv[2] if len(sys.argv) > 2 else "en").lower()
    if sys.argv[1] == "--plan":
        print(json.dumps(plan(language)), flush=True)
        sys.exit(0)
    kind = backend()
    if not kind:
        raise RuntimeError("no speech-recognition runtime in this Python")
    text, used = transcribe_mlx(sys.argv[1], language) if kind == "mlx" else transcribe_torch(sys.argv[1], language)
    print(json.dumps({"text": text, "model": used}), flush=True)
except Exception as e:  # never fail the clone flow over transcription
    print(json.dumps({"error": str(e)}), flush=True)
