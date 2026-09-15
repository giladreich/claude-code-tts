# Persistent Qwen3-TTS synthesis daemon for the Claude Code TTS VSCode extension.
#
# Loads the model once (a 0.6B/1.7B torch model must never reload per
# sentence), then serves synthesis requests over stdio:
#   stdin:  {"id": 1, "text": "...", "voice": "Ryan", "language": "English", "out": "/tmp/x.wav"}\n
#   stdout: {"id": 1, "ok": true}\n  (after the WAV is fully written)
#
# Two modes, chosen by the startup config (argv[1] JSON):
#   preset: {"model_id": ".../Qwen3-TTS-12Hz-0.6B-CustomVoice"}
#   clone:  {"model_id": ".../Qwen3-TTS-12Hz-0.6B-Base",
#            "clone": {"ref_audio": "/path/ref.wav", "ref_text": "..."}}
# In clone mode the voice prompt is computed ONCE and reused per request.
# Runs 100% locally; models are fetched from Hugging Face on first load.
import collections
import json
import sys
import threading
import wave

import numpy as np
import torch
from qwen_tts import Qwen3TTSModel

cfg = json.loads(sys.argv[1])
device = "mps" if torch.backends.mps.is_available() else ("cuda:0" if torch.cuda.is_available() else "cpu")
dtype = torch.float32 if device == "cpu" else torch.bfloat16
model = Qwen3TTSModel.from_pretrained(cfg["model_id"], device_map=device, dtype=dtype)

clone = cfg.get("clone")
GAIN = float((clone or {}).get("gain", 1.0))
# Voice-clone prompts are computed once per reference and cached, so a
# request may name another reference (auditioning a different cloned voice)
# without reloading the model.
prompts = collections.OrderedDict()
# A prompt is a set of tensors on the GPU: the cache is bounded, and what it
# lets go of is freed rather than left to the allocator's high-water mark.
PROMPT_CACHE = 8


def prompt_for(ref_audio, ref_text):
    key = (ref_audio, ref_text)
    if key in prompts:
        prompts.move_to_end(key)
        return prompts[key]
    prompts[key] = model.create_voice_clone_prompt(ref_audio=ref_audio, ref_text=ref_text)
    while len(prompts) > PROMPT_CACHE:
        prompts.popitem(last=False)
        release_memory()
    return prompts[key]


def release_memory():
    if device.startswith("cuda"):
        torch.cuda.empty_cache()
    elif device == "mps" and hasattr(torch, "mps"):
        torch.mps.empty_cache()


def to_pcm16(samples, gain):
    """Float samples (a numpy array or a tensor, on any device) to little-endian
    16-bit PCM bytes, with the clone's gain applied. Vectorized: the per-sample
    Python loop this replaces took longer than the vocoder for a long sentence."""
    if hasattr(samples, "detach"):
        samples = samples.detach().float().cpu().numpy()
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if gain != 1.0:
        samples = np.tanh(samples * gain) if gain > 1.0 else samples * gain
    return np.clip(samples * 32767.0, -32768.0, 32767.0).astype("<i2").tobytes()


if clone:
    prompt_for(clone["ref_audio"], clone["ref_text"])
# Requests are read on a thread: {"cancel": id} drops a queued request (a
# running torch generation cannot be aborted) and "priority": 1 requests
# are served before queued prewarm work.
urgent, background = [], []
cancelled = collections.OrderedDict()  # cancelled request ids, oldest first


def mark_cancelled(cid):
    """Called with cv held. Oldest out rather than all out: clearing the whole
    set when it grew past a thousand un-cancelled requests still queued, which
    then generated audio nobody would play."""
    cancelled[cid] = True
    while len(cancelled) > 2000:
        cancelled.popitem(last=False)


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
                mark_cancelled(req["cancel"])
            elif "id" in req:
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


threading.Thread(target=reader, daemon=True).start()
print(json.dumps({"ready": True, "device": device, "mode": "clone" if clone else "preset"}), flush=True)


def generate(req):
    language = req.get("language", "English")
    ref_audio = req.get("ref_audio") or (clone or {}).get("ref_audio")
    ref_text = req.get("ref_text") or (clone or {}).get("ref_text")
    if ref_audio and ref_text:
        clone_prompt = prompt_for(ref_audio, ref_text)
        # The batched form is ~3.5x faster than scalar in qwen-tts.
        try:
            return model.generate_voice_clone(
                text=[req["text"]], language=[language], voice_clone_prompt=clone_prompt
            )
        except (TypeError, ValueError):
            return model.generate_voice_clone(
                text=req["text"], language=language, voice_clone_prompt=clone_prompt
            )
    kwargs = {"text": req["text"], "language": language, "speaker": req.get("voice", "Ryan")}
    if req.get("style"):
        kwargs["instruct"] = str(req["style"])
    return model.generate_custom_voice(**kwargs)


while True:
    req = next_request()
    if req is None:
        break
    with cv:
        skip = req["id"] in cancelled
        cancelled.pop(req["id"], None)
    if skip:
        print(json.dumps({"id": req["id"], "ok": False, "error": "cancelled"}), flush=True)
        continue
    try:
        # No autograd bookkeeping for a model that is only ever read: the
        # graph it would build per token is memory the next sentence needs.
        with torch.inference_mode():
            wavs, sr = generate(req)
        pcm = to_pcm16(wavs[0], float(req.get("gain", GAIN)))
        with wave.open(req["out"], "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(int(sr))
            w.writeframes(pcm)
        print(json.dumps({"id": req["id"], "ok": True}), flush=True)
    except Exception as e:  # keep serving after a bad request
        print(json.dumps({"id": req["id"], "ok": False, "error": str(e)}), flush=True)
