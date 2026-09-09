# Persistent Qwen3-TTS synthesis daemon on Apple MLX (mlx-audio) for the
# Claude Code TTS VSCode extension. Stdio protocol:
#   stdin:  {"id": 1, "text": "...", "voice": "Ryan", "language": "English", "out": "/tmp/x.wav", "stream": true}\n
#   stdout: streaming -> {"id": 1, "part": "/tmp/x.p0.wav", "final": false} ... then {"id": 1, "ok": true}
#           non-stream -> {"id": 1, "ok": true} after writing "out"
# Config (argv[1] JSON): {"model_id": "mlx-community/...", "clone": {"ref_audio", "ref_text", "gain"}?}
# A request may carry its own "ref_audio"/"ref_text"/"gain" (any voice on the
# same Base checkpoint), which is what makes auditioning another cloned voice
# possible without reloading the model; mlx-audio caches the prompt per
# reference, so repeats are cheap.
#   {"cancel": 1} aborts request 1 (queued or mid-generation): it answers
#   {"id": 1, "ok": false, "error": "cancelled"}. Requests are read on a
#   thread so a cancel lands while the model is busy. "priority": 1 marks a
#   request the user is waiting on now (served before queued prewarm work).
#   Edge silence is trimmed (the first part's lead-in, and both ends of
#   whole-file output; a stream is closed by a silence part instead).
# mlx-audio caches the clone prompt per reference. Runs 100% locally.
import array
import json
import os
import sys
import threading
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speech_budget import expected_seconds
from mlx_audio.tts.utils import load_model

cfg = json.loads(sys.argv[1])
model = load_model(cfg["model_id"])
clone = cfg.get("clone")
# Per-profile loudness (Manage Voices); soft-limited so a boost cannot clip.
GAIN = float((clone or {}).get("gain", 1.0))
STREAM_INTERVAL = float(cfg.get("stream_interval", 0.5))
# Sampling: a mild repetition penalty for presets and clones alike; the
# talker occasionally fails to emit end-of-speech and babbles past the text.
REPETITION_PENALTY = float(cfg.get("repetition_penalty", 1.1))
TEMPERATURE = float(cfg.get("temperature", 0.8))
TOP_P = float(cfg.get("top_p", 0.95))


# Speech-length estimate (the runaway cutoff) lives in speech_budget.py,
# which counts Chinese, Japanese and Korean by character rather than by
# whitespace word. Three copies of it drifted apart once already.

# Warm-up: the first generation in a process pays for kernel compilation
# (several seconds). Do it now, before reporting ready, on a throwaway text.
try:
    _warm = {"text": "Ready.", "lang_code": "english"}
    if clone:
        _warm.update(ref_audio=clone["ref_audio"], ref_text=clone["ref_text"])
    else:
        _warm["voice"] = "Ryan"
    for _ in model.generate(**_warm):
        pass
except Exception as e:  # never block readiness on the warm-up
    print(json.dumps({"warmup_error": str(e)}), file=sys.stderr, flush=True)

# Streaming decodes the first chunk with a cold vocoder. The non-streaming
# path hands the vocoder the reference codes ahead of the generated ones and
# cuts that part off again, so its causal convolutions and attention cache
# are already carrying the speaker when the new speech starts; the streaming
# path (mlx-audio's _generate_icl) resets that state and decodes the new codes
# alone. Measured on the same generated codes, the cold decode opens at
# 190-200 Hz and slides down to the speaker's 85-115 Hz over the first half
# second (the "high, robotic start that settles"), and stays 50-70% off the
# reference decode even after that; primed with the reference codes it matches
# the reference decode (first 0.5s within 23%, the F0 track identical).
# Priming means decoding the reference once (about 1.2 s for 9 s of audio),
# so the primed state is taken once per reference and put back before every
# stream (about 1 ms): the conv buffers are reassigned rather than mutated
# and the KV cache reallocates on its next write, so a snapshot is not
# disturbed by the streams that start from it.
_primed_states = {}  # (ref_audio, ref_text) -> decoder state after the reference
_stream_ref = {"key": None, "fresh": True}
MAX_PRIMED_STATES = 8
try:
    import mlx.core as mx

    _decoder = model.speech_tokenizer.decoder.streaming_step.__self__  # the module behind mlx's proxy
    _decoder_step = _decoder.streaming_step
    _decoder_reset = _decoder.reset_streaming_state
except Exception as e:  # a checkpoint without this decoder streams cold, as before
    _decoder = None
    print(json.dumps({"prime_unavailable": str(e)}), file=sys.stderr, flush=True)


def _reference_codes(ref_audio, ref_text):
    """The reference's codec tokens, from the cache the model keeps per reference."""
    cache = getattr(model, "_icl_cache", None) or {}
    try:
        from mlx_audio.tts.models.qwen3_tts.qwen3_tts import load_audio

        audio = load_audio(ref_audio, sample_rate=model.sample_rate)
        hit = cache.get((ref_text, (audio.size, float(audio.sum()))))
        if hit is not None:
            return hit[0]
    except Exception:
        pass
    for key in reversed(list(cache)):  # the model keys on (ref_text, fingerprint)
        if key[0] == ref_text:
            return cache[key][0]
    return None


def _decoder_state():
    convs = {}
    for name, mod in _decoder.named_modules():
        for attr in ("_buffer", "_overflow"):
            if attr in vars(mod) or dict.__contains__(mod, attr):
                convs[(name, attr)] = vars(mod).get(attr, dict.get(mod, attr))
    kv = [c.state if c.keys is not None else None for c in _decoder._transformer_cache]
    for v in list(convs.values()) + [x for pair in kv if pair for x in pair]:
        if v is not None:
            mx.eval(v)
    return convs, kv


def _restore_decoder_state(state):
    convs, kv = state
    mods = dict(_decoder.named_modules())
    for (name, attr), v in convs.items():
        setattr(mods[name], attr, v)
    cache = _decoder.pre_transformer.make_cache()
    for c, st in zip(cache, kv):
        if st is not None:
            c.state = st
    _decoder._transformer_cache = cache


def _prime_decoder(key):
    state = _primed_states.get(key)
    if state is None:
        codes = _reference_codes(*key)
        if codes is None:
            print(json.dumps({"prime_skipped": os.path.basename(key[0])}), file=sys.stderr, flush=True)
            return
        t = time.time()
        mx.eval(_decoder_step(codes))
        state = _decoder_state()
        if len(_primed_states) >= MAX_PRIMED_STATES:
            _primed_states.pop(next(iter(_primed_states)))
        _primed_states[key] = state
        print(json.dumps({"primed": os.path.basename(key[0]), "tokens": int(codes.shape[2]), "ms": int((time.time() - t) * 1000)}), file=sys.stderr, flush=True)
    _restore_decoder_state(state)


def _reset_streaming_state():
    _decoder_reset()
    _stream_ref["fresh"] = True


def _streaming_step(codes):
    if _stream_ref["fresh"]:
        _stream_ref["fresh"] = False
        if _stream_ref["key"] is not None:
            try:
                _prime_decoder(_stream_ref["key"])
            except Exception as e:  # a stream still plays, cold, as before
                print(json.dumps({"prime_error": str(e)}), file=sys.stderr, flush=True)
    return _decoder_step(codes)


if _decoder is not None:
    _decoder.reset_streaming_state = _reset_streaming_state
    _decoder.streaming_step = _streaming_step
    # The daemon's own voice is primed now, while nobody is waiting.
    if clone:
        try:
            _decoder_reset()
            _prime_decoder((clone["ref_audio"], clone["ref_text"]))
            _decoder_reset()
        except Exception as e:
            print(json.dumps({"prime_error": str(e)}), file=sys.stderr, flush=True)

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


def is_cancelled(rid):
    with cv:
        return rid in cancelled


EDGE_KEEP = 0.06  # lead-in silence kept (seconds)
TAIL_KEEP = 0.35  # tail silence kept on whole-file output
END_BREATH = 0.3  # silence closing a stream: the breath before the next utterance
EDGE_THRESHOLD = 0.01


def _edge_threshold(a):
    # Cloned voices carry the reference's room tone, so "silence" is relative
    # to the part's own peak rather than a fixed floor.
    peak = float(np.abs(a).max()) if a.size else 0.0
    return max(EDGE_THRESHOLD, 0.06 * peak)


def trim_leading(a, sr):
    idx = np.flatnonzero(np.abs(a) >= _edge_threshold(a))
    if idx.size == 0:
        return a
    cut = max(0, int(idx[0]) - int(sr * EDGE_KEEP))
    return a[cut:]


def trim_trailing(a, sr):
    idx = np.flatnonzero(np.abs(a) >= _edge_threshold(a))
    if idx.size == 0:
        return a
    cut = min(a.size, int(idx[-1]) + 1 + int(sr * TAIL_KEEP))
    return a[:cut]


threading.Thread(target=reader, daemon=True).start()
print(json.dumps({"ready": True, "runtime": "mlx", "mode": "clone" if clone else "preset"}), flush=True)


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


def write_wav(path, audio, sr, gain=None):
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    g = GAIN if gain is None else float(gain)
    if g != 1.0:
        a = a * g
    a = soft_limit(a)
    pcm = array.array("h", np.clip(a * 32767, -32768, 32767).astype(np.int16).tolist())
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def gen_kwargs(req, stream):
    kw = {"text": req["text"], "lang_code": str(req.get("language", "auto")).lower()}
    # Runaway guard: ~12.5 codec tokens/s. Stop a little past the expected
    # length so a generation that never ends cannot babble for minutes; the
    # streaming loop below cuts even earlier.
    kw["max_tokens"] = int(12.5 * expected_seconds(req["text"]) * 1.25)
    kw["repetition_penalty"] = REPETITION_PENALTY
    kw["temperature"] = TEMPERATURE
    kw["top_p"] = TOP_P
    # A per-request reference wins over the one the daemon started with.
    ref_audio = req.get("ref_audio") or (clone or {}).get("ref_audio")
    ref_text = req.get("ref_text") or (clone or {}).get("ref_text")
    if ref_audio and ref_text:
        kw["ref_audio"] = ref_audio
        kw["ref_text"] = ref_text
    else:
        kw["voice"] = req.get("voice", "Ryan")
        if req.get("style"):
            kw["instruct"] = str(req["style"])
    if stream:
        kw["stream"] = True
        kw["streaming_interval"] = STREAM_INTERVAL
    _stream_ref["key"] = (kw["ref_audio"], kw["ref_text"]) if "ref_audio" in kw else None
    return kw


# mlx-audio's generate() raises the repetition penalty to at least 1.5 for
# cloned voices ("code degeneration with long reference audio prefills").
# Measured against the speaker's own recording, that setting flattens the
# voice: pitch variety (std of log F0) 0.19 against the speaker's 0.31, and a
# noisier spectrum (flatness 0.72 against 0.64), where 1.1 gave 0.23 and
# 0.52, with the same rate of runaway sentences (1 in 20 either way, and the
# cutoff above catches those). So clones are generated through the clone
# path directly, with the daemon's own penalty, whenever that path still
# takes the arguments this was written against; otherwise generate() as before.
_ref_audio_cache = {}
_icl_reported = {"done": False}


def _loaded_reference(path):
    audio = _ref_audio_cache.get(path)
    if audio is None:
        from mlx_audio.tts.models.qwen3_tts.qwen3_tts import load_audio

        audio = load_audio(path, sample_rate=model.sample_rate)
        _ref_audio_cache[path] = audio
    return audio


def generate(req, stream):
    kw = gen_kwargs(req, stream)
    icl = getattr(model, "_generate_icl", None)
    if "ref_audio" in kw and icl is not None:
        try:
            import inspect

            params = inspect.signature(icl).parameters
            call = {
                "text": kw["text"],
                "ref_audio": _loaded_reference(kw["ref_audio"]),
                "ref_text": kw["ref_text"],
                "language": kw["lang_code"],
                "temperature": kw["temperature"],
                "top_p": kw["top_p"],
                "repetition_penalty": kw["repetition_penalty"],
                "max_tokens": kw["max_tokens"],
            }
            if stream:
                call["stream"] = True
                call["streaming_interval"] = STREAM_INTERVAL
            if all(name in params for name in call):
                if not _icl_reported["done"]:
                    _icl_reported["done"] = True
                    print(json.dumps({"icl": "direct", "repetition_penalty": kw["repetition_penalty"]}), file=sys.stderr, flush=True)
                return icl(**call)
        except Exception as e:  # the library moved; the public path still works
            print(json.dumps({"icl_fallback": str(e)}), file=sys.stderr, flush=True)
    return model.generate(**kw)


while True:
    req = next_request()
    if req is None:
        break
    rid = req["id"]
    if is_cancelled(rid):
        print(json.dumps({"id": rid, "ok": False, "error": "cancelled"}), flush=True)
        continue
    gain = req.get("gain")
    t_gen = time.time()
    try:
        if req.get("stream"):
            base = req["out"][:-4] if req["out"].endswith(".wav") else req["out"]
            n = 0
            limit = expected_seconds(req["text"])
            produced = 0.0
            sr = 24000
            # Each chunk is emitted as soon as it exists (latency); the stream
            # is closed by a short silence part flagged final (the breath at
            # the end of the utterance, and the marker the player needs).
            for r in generate(req, True):
                if is_cancelled(rid):
                    break
                a = np.asarray(r.audio, dtype=np.float32).reshape(-1)
                if a.size == 0:
                    continue
                sr = r.sample_rate
                produced += a.size / float(sr)
                if n == 0:
                    a = trim_leading(a, sr)
                p = f"{base}.p{n}.wav"
                write_wav(p, a, sr, gain)
                print(json.dumps({"id": rid, "part": p, "final": False}), flush=True)
                n += 1
                if produced > limit:
                    # Past what the text can plausibly need: the model is
                    # babbling. Stop here rather than play the garbage.
                    print(json.dumps({"runaway": True, "text": req["text"][:60], "produced": round(produced, 1)}), file=sys.stderr, flush=True)
                    break
            if is_cancelled(rid):
                for i in range(n):
                    try:
                        os.unlink(f"{base}.p{i}.wav")
                    except OSError:
                        pass
                raise RuntimeError("cancelled")
            if n == 0:
                raise RuntimeError("no audio produced")
            tail = f"{base}.p{n}.wav"
            pause_scale = float(req.get("pause_scale", 1.0))
            write_wav(tail, np.zeros(int(sr * END_BREATH * pause_scale), dtype=np.float32), sr)
            print(json.dumps({"id": rid, "part": tail, "final": True}), flush=True)
            gen = time.time() - t_gen
            print(json.dumps({"request": rid, "priority": req.get("priority", 0), "gen_s": round(gen, 2), "audio_s": round(produced, 2),
                              "rtf": round(gen / max(produced, 0.01), 2), "text": req["text"][:40]}), file=sys.stderr, flush=True)
            print(json.dumps({"id": rid, "ok": True, "gen_s": round(gen, 2), "audio_s": round(produced, 2)}), flush=True)
        else:
            results = list(generate(req, False))
            audio = np.concatenate([np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in results])
            sr = results[0].sample_rate
            limit = int(expected_seconds(req["text"]) * sr)
            if audio.size > limit:
                print(json.dumps({"runaway": True, "text": req["text"][:60], "produced": round(audio.size / sr, 1)}), file=sys.stderr, flush=True)
                audio = audio[:limit]
            write_wav(req["out"], trim_trailing(trim_leading(audio, sr), sr), sr, gain)
            gen = time.time() - t_gen
            audio_s = audio.size / sr
            print(json.dumps({"request": rid, "priority": req.get("priority", 0), "gen_s": round(gen, 2), "audio_s": round(audio_s, 2),
                              "rtf": round(gen / max(audio_s, 0.01), 2), "text": req["text"][:40]}), file=sys.stderr, flush=True)
            print(json.dumps({"id": rid, "ok": True, "gen_s": round(gen, 2), "audio_s": round(audio_s, 2)}), flush=True)
    except Exception as e:  # keep serving after a bad request
        print(json.dumps({"id": rid, "ok": False, "error": str(e)}), flush=True)
    finally:
        with cv:
            cancelled.discard(rid)
