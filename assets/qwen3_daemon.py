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
import os
import sys
import threading
import time
import wave

import numpy as np
import torch
from qwen_tts import Qwen3TTSModel

import qwen3_fast
from speech_budget import expected_seconds

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
# The reference asks transformers for a whole generation pass per frame for
# the frame's codebooks; sampling them directly measured 20-25% faster on a
# laptop GPU, with the reference path restored on the first surprise.
if cfg.get("fast", True):
    qwen3_fast.install(model, log=lambda s: print(s, file=sys.stderr, flush=True))
# The codec decoder runs in float32: a stream is decoded prefix by prefix,
# and in bfloat16 two decodes of the same frames differed by up to 0.014
# (a faint click at every seam); in float32 by 0.0006. It is a small model,
# 134 ms for seven seconds of audio against 49.
try:
    qwen3_fast.decoder_module(model).float()
except Exception as e:
    print(f"codec decoder kept in its own precision ({type(e).__name__}: {e})", file=sys.stderr, flush=True)
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


def is_cancelled(rid):
    with cv:
        return rid in cancelled


def clone_prompt_for(req):
    ref_audio = req.get("ref_audio") or (clone or {}).get("ref_audio")
    ref_text = req.get("ref_text") or (clone or {}).get("ref_text")
    return prompt_for(ref_audio, ref_text) if ref_audio and ref_text else None


def generate(req, **extra):
    language = req.get("language", "English")
    clone_prompt = clone_prompt_for(req)
    if clone_prompt is not None:
        # The batched form is ~3.5x faster than scalar in qwen-tts.
        try:
            return model.generate_voice_clone(
                text=[req["text"]], language=[language], voice_clone_prompt=clone_prompt, **extra
            )
        except (TypeError, ValueError):
            return model.generate_voice_clone(
                text=req["text"], language=language, voice_clone_prompt=clone_prompt, **extra
            )
    kwargs = {"text": req["text"], "language": language, "speaker": req.get("voice", "Ryan"), **extra}
    if req.get("style"):
        kwargs["instruct"] = str(req["style"])
    return model.generate_custom_voice(**kwargs)


def write_wav(path, samples, sr, gain):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(to_pcm16(samples, gain))


# 12 Hz frames: the first part goes out after this many, the rest every
# CHUNK_FRAMES. Half a second is enough to start speaking on; a second per
# part keeps the decoder (a whole-prefix decode each time) cheap.
FIRST_FRAMES = 6
CHUNK_FRAMES = 12
FRAME_RATE = 12.5  # 24 kHz at 1920 samples per frame, measured on the reference decoder
END_BREATH = 0.3  # silence closing a stream: the breath before the next utterance


def synthesize(req, rid):
    """
    One request: the whole utterance to `out`, or, with "stream": true, parts
    handed out as the talker makes frames (the codec decoder is causal, so a
    prefix of the frames decodes to the very audio the whole utterance
    decodes to over those frames). A cancel lands inside the talker's step
    and ends the generation there; the runaway cutoff is the token budget
    the text can plausibly need.
    """
    text = req["text"]
    gain = float(req.get("gain", GAIN))
    out = req["out"]
    streaming = bool(req.get("stream"))
    base = out[:-4] if out.lower().endswith(".wav") else out
    prompt = clone_prompt_for(req)
    ref_codes = None
    if prompt is not None:
        ref_list = prompt.get("ref_code") if isinstance(prompt, dict) else None
        if ref_list and ref_list[0] is not None:
            ref_codes = ref_list[0]
    eos = qwen3_fast.eos_token_id(model)
    limit_seconds = expected_seconds(text)
    frames = []
    parts = []
    emitted = 0
    state = {"next": FIRST_FRAMES}
    pause_scale = float(req.get("pause_scale", 1.0))

    def emit(final, full_wav=None, sr=24000):
        nonlocal emitted
        if full_wav is None:
            full_wav, sr = qwen3_fast.decode_codes(model, torch.stack(frames), ref_codes)
        part = full_wav[emitted:]
        if final:
            part = np.concatenate([part, np.zeros(int(sr * END_BREATH * pause_scale), dtype=np.float32)])
        elif part.size == 0:
            return sr
        path = f"{base}.p{len(parts)}.wav"
        write_wav(path, part, sr, gain)
        parts.append(path)
        emitted = len(full_wav)
        state["next"] = len(frames) + CHUNK_FRAMES
        print(json.dumps({"id": rid, "part": path, "final": final}), flush=True)
        return sr

    def on_frame(codec_ids):
        if is_cancelled(rid):
            raise qwen3_fast.Cancelled()
        if eos is not None and int(codec_ids[0, 0]) == eos:
            return
        frames.append(codec_ids[0].detach())
        if streaming and len(frames) >= state["next"]:
            emit(False)

    t0 = time.time()
    try:
        with qwen3_fast.FrameTap(model, on_frame):
            # No autograd bookkeeping for a model that is only ever read: the
            # graph it would build per token is memory the next sentence needs.
            with torch.inference_mode():
                wavs, sr = generate(req, max_new_tokens=int(limit_seconds * FRAME_RATE + FRAME_RATE))
    except qwen3_fast.Cancelled:
        for p in parts:
            try:
                os.unlink(p)
            except OSError:
                pass
        raise RuntimeError("cancelled")
    full = wavs[0]
    if hasattr(full, "detach"):
        full = full.detach().float().cpu().numpy()
    full = np.asarray(full, dtype=np.float32).reshape(-1)
    seconds = len(full) / float(sr)
    if seconds > limit_seconds:
        print(json.dumps({"runaway": True, "text": text[:60], "produced": round(seconds, 1)}), file=sys.stderr, flush=True)
    if streaming:
        emit(True, full, sr)
    else:
        write_wav(out, full, sr, gain)
    gen = time.time() - t0
    print(json.dumps({"request": rid, "gen_s": round(gen, 2), "audio_s": round(seconds, 2), "rtf": round(gen / max(seconds, 0.01), 2), "parts": len(parts), "text": text[:40]}), file=sys.stderr, flush=True)
    return gen, seconds


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
        gen, seconds = synthesize(req, req["id"])
        print(json.dumps({"id": req["id"], "ok": True, "gen_s": round(gen, 2), "audio_s": round(seconds, 2)}), flush=True)
    except Exception as e:  # keep serving after a bad request
        print(json.dumps({"id": req["id"], "ok": False, "error": str(e)}), flush=True)
    finally:
        with cv:
            cancelled.pop(req["id"], None)
