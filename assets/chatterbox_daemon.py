# Persistent Chatterbox Multilingual synthesis daemon (PyTorch) for the Claude
# Voice VSCode extension: the runtime for Linux, Windows and Macs without the
# MLX tool. Chatterbox (Resemble AI, MIT) clones a voice from a short reference
# and speaks the 23 languages the extension exposes (see ENGINE_LANGUAGES; one
# of them read as garbled until the text was prepared first, see diacritize.py).
# About 2.4x slower than realtime on Apple Silicon, so the model is loaded once
# and kept warm.
#
#   stdin:  {"id": 1, "text": "...", "language": "ar", "ref_audio": "/path/ref.wav",
#            "out": "/tmp/x.wav", "gain": 1.0, "priority": 1}
#   stdout: {"id": 1, "part": "/tmp/x.wav", "final": true} then {"id": 1, "ok": true}
#   {"cancel": 1} drops a queued request (a running generation cannot be aborted).
# Runs 100% locally; weights come from Hugging Face on first use.
import json
import os
import sys
import threading
import time
import wave

import numpy as np
import torch
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from diacritize import prepare  # vowel marks and spoken numbers
from speech_budget import expected_seconds

cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
device = cfg.get("device") or (
    "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
)
model = ChatterboxMultilingualTTS.from_pretrained(device=device)
SUPPORTED = sorted(getattr(model, "get_supported_languages", lambda: {})().keys()) or []
# generate(audio_prompt_path=...) replaces model.conds in place, so once any
# voice has been cloned the checkpoint's own speaker is gone unless kept here.
BUILTIN_CONDS = getattr(model, "conds", None)
# Conditioning per reference file, computed once: prepare_conditionals runs
# the voice encoder, the S3 tokenizer and the decoder prompt (seconds of work)
# and was being repeated for every sentence. Keyed by file identity so a
# reference rewritten in place (refine, re-record) is picked up.
_conds = {}
_CONDS_MAX = 8


def conditioning(path):
    try:
        st = os.stat(path)
        key = (path, st.st_mtime_ns, st.st_size)
    except OSError:
        key = (path, 0, 0)
    if key not in _conds:
        if len(_conds) >= _CONDS_MAX:
            _conds.pop(next(iter(_conds)))
        model.prepare_conditionals(path)
        _conds[key] = model.conds
    return _conds[key]

urgent, background = [], []
cancelled = set()
cv = threading.Condition()
eof = False


def reader():
    global eof
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        with cv:
            if "cancel" in req:
                cancelled.add(req["cancel"])
                if len(cancelled) > 1000:
                    cancelled.clear()
            else:
                req["_queued_at"] = time.time()
                (urgent if req.get("priority") else background).append(req)
            cv.notify()
    with cv:
        eof = True
        cv.notify()


def next_request():
    with cv:
        while not urgent and not background and not eof:
            cv.wait()
        if urgent:
            return urgent.pop(0)
        if background:
            return background.pop(0)
        return None


# Speech-length estimate (the runaway cutoff) lives in speech_budget.py,
# which counts Chinese, Japanese and Korean by character rather than by
# whitespace word. Three copies of it drifted apart once already.


EDGE_KEEP = 0.06  # lead-in silence kept (seconds)
TAIL_KEEP = 0.35  # tail silence kept


def trim(a, sr):
    # Cloned voices carry the reference's room tone, so "silence" is relative
    # to the clip's own peak rather than a fixed floor.
    peak = float(np.abs(a).max()) if a.size else 0.0
    idx = np.flatnonzero(np.abs(a) >= max(0.01, 0.06 * peak))
    if idx.size == 0:
        return a
    start = max(0, int(idx[0]) - int(sr * EDGE_KEEP))
    end = min(a.size, int(idx[-1]) + 1 + int(sr * TAIL_KEEP))
    return a[start:end]


# Headroom. The codec decoder saturates at full scale (4 of 10 measured
# generations peaked at exactly 1.0), and the player's time-stretch overshoots
# what it is given, so audio delivered at 0 dBFS clips on the way out. Below
# the knee the signal is untouched; above it the excess is folded into the
# room left under the ceiling. A tanh over the whole signal did this first
# and measured 3.6% harmonic distortion on a 0.6 sine and 6% on 0.8, which is
# most stressed syllables: a grit heard as "machine". This shape is 0% to 0.7
# and 0.6% at 0.8.
CEILING = 0.89
KNEE = 0.7


def soft_limit(a):
    mag = np.abs(a)
    over = mag > KNEE
    if not over.any():
        return a
    out = mag.copy()
    out[over] = KNEE + (CEILING - KNEE) * np.tanh((mag[over] - KNEE) / (CEILING - KNEE))
    return np.sign(a) * out


def write_wav(path, audio, sr, gain=1.0):
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if gain != 1.0:
        a = a * gain
    a = soft_limit(a)
    pcm = np.clip(a * 32767, -32768, 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm)


# Warm up before reporting ready: the first generation pays for kernel setup.
try:
    if cfg.get("ref_audio"):
        model.conds = conditioning(cfg["ref_audio"])
    if model.conds is not None:
        model.generate(text="Ready.", language_id="en")
except Exception as e:
    print(json.dumps({"warmup_error": str(e)}), file=sys.stderr, flush=True)

threading.Thread(target=reader, daemon=True).start()
print(json.dumps({"ready": True, "device": device, "languages": SUPPORTED}), flush=True)

while True:
    req = next_request()
    if req is None:
        break
    rid = req["id"]
    with cv:
        skip = rid in cancelled
        cancelled.discard(rid)
    if skip:
        print(json.dumps({"id": rid, "ok": False, "error": "cancelled"}), flush=True)
        continue
    try:
        waited = time.time() - req.get("_queued_at", time.time())
        t_gen = time.time()
        # Prepared first: some writing systems need vowel marks, numbers need words
        # (see diacritize.py), or the model guesses and says other words.
        text = prepare(req["text"], req.get("language", "en"))
        kwargs = {"text": text, "language_id": req.get("language", "en")}
        # An explicit key wins over the startup config, null included.
        ref = req["ref_audio"] if "ref_audio" in req else cfg.get("ref_audio")
        if ref:
            model.conds = conditioning(ref)
        elif BUILTIN_CONDS is not None:
            model.conds = BUILTIN_CONDS
        else:
            raise RuntimeError("this checkpoint has no built-in voice: a reference is required")
        wav = model.generate(**kwargs)
        audio = wav.detach().cpu().numpy() if hasattr(wav, "detach") else np.asarray(wav)
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        # Runaway guard: a generation that never emits end-of-speech babbles
        # past the text. Cut at what the text can plausibly need.
        limit = int(expected_seconds(text) * model.sr)
        if audio.size > limit:
            print(json.dumps({"runaway": True, "text": req["text"][:60], "produced": round(audio.size / model.sr, 1)}), file=sys.stderr, flush=True)
            audio = audio[:limit]
        gen = time.time() - t_gen
        audio_s = audio.size / model.sr
        print(
            json.dumps({"request": rid, "priority": req.get("priority", 0), "waited_s": round(waited, 2), "gen_s": round(gen, 2),
                        "audio_s": round(audio_s, 2), "rtf": round(gen / max(audio_s, 0.01), 2), "text": req["text"][:40]}),
            file=sys.stderr, flush=True,
        )
        out = req["out"]
        write_wav(out, trim(audio, model.sr), model.sr, float(req.get("gain", 1.0)))
        print(json.dumps({"id": rid, "part": out, "final": True}), flush=True)
        print(json.dumps({"id": rid, "ok": True, "gen_s": round(gen, 2), "audio_s": round(audio_s, 2)}), flush=True)
    except Exception as e:  # keep serving after a bad request
        print(json.dumps({"id": rid, "ok": False, "error": str(e)}), flush=True)
