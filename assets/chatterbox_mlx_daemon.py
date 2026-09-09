# Persistent Chatterbox Multilingual synthesis daemon on Apple MLX
# (mlx-audio) for the Claude Code TTS VSCode extension. Same stdio protocol as
# chatterbox_daemon.py, but this is the runtime to prefer on Apple Silicon:
#
#   - It runs the v3 checkpoint (mlx-community/chatterbox-multilingual-v3).
#     The PyPI chatterbox-tts package pins the older v2 weights and has no
#     argument to change them. One non-Latin language was verified on both
#     checkpoints, the rest on v3 only; one is garbled on both without the
#     text preparation below.
#   - Measured 1.45x realtime here (median 1.43, p90 1.59 over 20 sustained
#     runs) against 2.4x for torch-on-Metal, about 1.7x faster. Still slower
#     than playback, so the pipeline caps the speaking rate at what this
#     sustains and the voice stays in sync instead of falling behind.
#
#   stdin:  {"id": 1, "text": "...", "language": "ar", "ref_audio": "/path/ref.wav",
#            "out": "/tmp/x.wav", "gain": 1.0, "priority": 1}
#   stdout: {"id": 1, "part": "/tmp/x.wav", "final": true} then {"id": 1, "ok": true}
#   {"id": 2, "convert": "/tmp/piper.wav", "ref_audio": "/path/ref.wav", "out": "/tmp/y.wav"}
#            re-voices existing speech in the reference's timbre (voice
#            conversion): the S3 tokenizer reads the source into speech tokens
#            and s3gen renders them with the reference's conditioning. The words
#            come from the source, so a language this model cannot pronounce
#            (from another engine's voice) can still be heard in a cloned voice.
#   {"id": 3, "text": "...", "stream": true, ...} streams: {"id": 3, "part": "/tmp/x.p0.wav",
#            "final": false} as each segment is ready, a final part, then {"id": 3, "ok": true}.
#   {"cancel": 1} drops a queued request; a STREAMING generation also stops at
#            its next token, a whole-chunk one cannot be aborted.
# Chatterbox itself has no streaming mode (mlx-audio accepts stream=True and
# ignores it) and no speed control; the rate is applied by time-stretch
# downstream. Streaming is done here instead: see stream_generate.
# Runs 100% locally; weights come from Hugging Face on first use.
import json
import os
import sys
import threading
import time
import wave

import numpy as np
from mlx_audio.tts.utils import load_model
from mlx_audio.utils import load_audio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from diacritize import prepare
from speech_budget import expected_seconds

def _phase(name):
    print(json.dumps({"boot": name}), file=sys.stderr, flush=True)


cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
_phase("config")
MODEL_ID = cfg.get("model_id", "mlx-community/chatterbox-multilingual-v3")
model = load_model(MODEL_ID)
_phase("model loaded")
SR = 24000
# Guidance weight: 0.5 is the model default. Sampling mirrors the Qwen3
# daemon, where a mild repetition penalty stops the occasional babble.
CFG_WEIGHT = float(cfg.get("cfg_weight", 0.5))
EXAGGERATION = float(cfg.get("exaggeration", 0.5))
TEMPERATURE = float(cfg.get("temperature", 0.8))
REPETITION_PENALTY = float(cfg.get("repetition_penalty", 1.2))
GAIN = float(cfg.get("gain", 1.0))
# The vocoder turns speech tokens into audio by solving a flow-matching ODE,
# ten Euler steps by default, and that is a large share of the time: measured
# here it ran slower than realtime on its own. Four steps produced the same
# words and the same voice on eight sentences (CER 0.162 against 0.173,
# identical WER, speaker similarity 0.897 against 0.902), so the extra six
# steps buy nothing audible. Configurable because it is a quality knob: raise
# it if a voice ever sounds rough.
VOCODER_STEPS = int(cfg.get("vocoder_steps", 4))
# Streaming: the token model is driven a step at a time and the vocoder is run
# as segments of tokens complete, so the first words play while the rest is
# still being generated. The first segment is short (the first word), later
# ones longer (each segment is vocoded with a little context before it, so
# fewer segments cost less). Measured through this daemon on one 10 s
# paragraph, with the token model quantised: first audio after 2.8 s instead
# of 6.3 s, at the same intelligibility and voice similarity as the whole
# chunk (CER 0.04 both ways, similarity 0.923 against 0.910 in the prototype).
# The vocoder starts from random noise, so it is re-seeded before every
# segment and the seam is crossfaded over 30 ms.
# Quantise the token model in memory at load (8 or 4 bits; 0 leaves bf16).
# The weights are the same MIT checkpoint: nothing else is downloaded. Layers
# whose input width does not divide the group size (a 1-wide projection in
# this model) are left alone, or mlx refuses the whole module.
QUANTIZE_BITS = int(cfg.get("quantize_bits", 8))
if QUANTIZE_BITS in (4, 8):
    try:
        import mlx.core as _mx
        import mlx.nn as _nn

        _nn.quantize(
            model.t3, group_size=64, bits=QUANTIZE_BITS,
            class_predicate=lambda _p, mod: isinstance(mod, _nn.Linear) and mod.weight.shape[-1] % 64 == 0,
        )
        _mx.eval(model.t3.parameters())
        print(json.dumps({"quantized": "t3", "bits": QUANTIZE_BITS}), file=sys.stderr, flush=True)
    except Exception as e:  # keep the bf16 model rather than fail to start
        print(json.dumps({"quantize_error": f"{type(e).__name__}: {e}"}), file=sys.stderr, flush=True)
_phase("configured")
STREAM_FIRST_TOKENS = int(cfg.get("stream_first_tokens", 50))  # 25 tokens is a second of speech
STREAM_NEXT_TOKENS = int(cfg.get("stream_next_tokens", 100))
# Each segment is vocoded from a WINDOW: the new tokens plus this much of what
# came before, for the vocoder's context, whose audio is then discarded.
# Vocoding the whole prefix every time was quadratic, and once the token
# model was quantised it dominated: a streamed chunk took twice as long as a
# whole one. A window keeps the cost linear. 0 means the whole prefix.
STREAM_CONTEXT_TOKENS = int(cfg.get("stream_context_tokens", 40))
SAMPLES_PER_TOKEN = SR // 25  # 25 speech tokens per second, 960 samples each at 24 kHz
CROSSFADE = int(SR * 0.03)
# The vocoder's output is damaged near the END of a window that is not final:
# the flow drops its 3-token lookahead, but the last 140-300 ms of what
# remains still carried full-scale discontinuities (measured sample by
# sample). So that much is held back from every non-final segment and
# vocoded again, away from the edge, in the next window; the 30 ms tail kept
# for the seam blend is taken from before it.
END_MARGIN = int(SR * 0.4)
# The vocoder's output does not land on the token arithmetic to the sample
# (measured seam jump 0.23 at RMS 0.19 when it was trusted), so each seam is
# aligned by correlating the 30 ms kept from the previous segment against
# the new one within this search range, and the blend starts where they fit.
SEAM_SEARCH = int(SR * 0.02)
VOCODE_SEED = 1234


def align_seam(tail, new, at, search=SEAM_SEARCH):
    """Offset within +-search at which `new[at+off : at+off+len(tail)]` best
    matches `tail` (normalised correlation); 0 when there is nothing to go on."""
    n = tail.size
    if n == 0 or new.size < at + n + search:
        return 0
    best, best_off = -2.0, 0
    tn = tail - tail.mean()
    tnorm = float(np.sqrt(np.dot(tn, tn))) + 1e-9
    for off in range(-search, search + 1, 8):  # a third of a millisecond apart
        i = at + off
        if i < 0 or i + n > new.size:
            continue
        seg = new[i:i + n]
        sn = seg - seg.mean()
        c = float(np.dot(tn, sn)) / (tnorm * (float(np.sqrt(np.dot(sn, sn))) + 1e-9))
        if c > best:
            best, best_off = c, off
    return best_off
_stream_fallback_logged = False
try:
    if VOCODER_STEPS > 0:
        model.s3gen.flow.n_timesteps = VOCODER_STEPS
except AttributeError:  # a future mlx-audio may restructure this
    print(json.dumps({"vocoder_steps": "not settable on this mlx-audio"}), file=sys.stderr, flush=True)

# The finished conditioning is cached, not just the decoded samples: passing
# ref_audio makes generate() re-run prepare_conditionals on every utterance
# (speaker embedding, tokenizer, decoder prompt), which is measurable work on
# an engine that already runs slower than realtime. Keyed by file identity
# rather than path, because refining, re-recording or re-designing a voice
# rewrites ref.wav at the SAME path and a path-keyed cache would keep speaking
# the old voice for the rest of the session. Bounded so a long session
# auditioning many voices cannot grow it without limit.
_refs = {}
_REF_CACHE_MAX = 8


def conditioning(path):
    try:
        st = os.stat(path)
        key = (path, st.st_mtime_ns, st.st_size)
    except OSError:
        key = (path, 0, 0)
    if key not in _refs:
        if len(_refs) >= _REF_CACHE_MAX:
            _refs.pop(next(iter(_refs)))
        audio = load_audio(path, sample_rate=SR)
        _refs[key] = model.prepare_conditionals(audio, SR, EXAGGERATION)
    return _refs[key]


# Speech-length estimate (the runaway cutoff) lives in speech_budget.py,
# which counts Chinese, Japanese and Korean by character rather than by
# whitespace word. Three copies of it drifted apart once already.


EDGE_KEEP = 0.06  # lead-in silence kept (seconds)
TAIL_KEEP = 0.35  # tail silence kept
EDGE_THRESHOLD = 0.01


def _edge_threshold(a):
    # Cloned voices carry the reference's room tone, so "silence" is relative
    # to the clip's own peak rather than a fixed floor.
    peak = float(np.abs(a).max()) if a.size else 0.0
    return max(EDGE_THRESHOLD, 0.06 * peak)


def trim(a, sr):
    idx = np.flatnonzero(np.abs(a) >= _edge_threshold(a))
    if idx.size == 0:
        return a
    start = max(0, int(idx[0]) - int(sr * EDGE_KEEP))
    end = min(a.size, int(idx[-1]) + 1 + int(sr * TAIL_KEEP))
    return a[start:end]


def trim_leading(a, sr):
    idx = np.flatnonzero(np.abs(a) >= _edge_threshold(a))
    if idx.size == 0:
        return a
    return a[max(0, int(idx[0]) - int(sr * EDGE_KEEP)):]


def trim_trailing(a, sr):
    idx = np.flatnonzero(np.abs(a) >= _edge_threshold(a))
    if idx.size == 0:
        return a
    return a[: min(a.size, int(idx[-1]) + 1 + int(sr * TAIL_KEEP))]


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
    pcm = np.clip(a * 32767, -32768, 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm)


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


def gen_kwargs(req):
    # Some writing systems are unintelligible without their vowel marks, and
    # numbers are otherwise guessed at,
    # so the text is prepared before it reaches the model (see diacritize.py).
    text = prepare(req["text"], req.get("language", "en"))
    kw = {
        "text": text,
        "lang_code": str(req.get("language", "en")).lower(),
        "cfg_weight": CFG_WEIGHT,
        "exaggeration": EXAGGERATION,
        "temperature": TEMPERATURE,
        "repetition_penalty": REPETITION_PENALTY,
        # Runaway guard: the speech tokenizer runs at 25 tokens/s, so stop a
        # little past what the text can plausibly need rather than let a
        # generation that never emits end-of-speech babble for minutes.
        "max_tokens": int(25 * expected_seconds(text) * 1.25),
    }
    # An explicit key wins over the startup config, null included: falling
    # back here would keep an old voice alive after the user cleared it.
    ref = req["ref_audio"] if "ref_audio" in req else cfg.get("ref_audio")
    if ref:
        kw["conds"] = conditioning(ref)
    return kw


def convert_voice(src, ref):
    """Speech tokens of `src`, rendered with the conditioning of `ref`."""
    import mlx.core as mx  # here, not at import: the rest of the daemon does not need it directly
    from mlx_audio.tts.models.chatterbox.s3tokenizer import log_mel_spectrogram

    audio = load_audio(src, sample_rate=16000)
    if getattr(audio, "ndim", 1) == 2:
        audio = audio.squeeze(0)
    mel = mx.expand_dims(log_mel_spectrogram(audio), 0)
    tokens, lengths = model._s3_tokenizer(mel, mx.array([mel.shape[2]]))
    n = int(np.array(lengths)[0])
    wav, _ = model.s3gen.inference(speech_tokens=tokens[:, :n], ref_dict=conditioning(ref).gen)
    mx.eval(wav)
    return np.asarray(wav, dtype=np.float32).reshape(-1)


def is_cancelled(rid):
    with cv:
        return rid in cancelled


class Cancelled(Exception):
    pass


def stream_generate(req, ref, on_part):
    """Generate speech tokens one at a time and hand audio to on_part(audio,
    final) as segments become available. The same arithmetic as the model's
    own generate(), driven through its public modules; anything that no
    longer fits (an mlx-audio upgrade) raises, and the caller falls back to
    the whole-chunk path."""
    import mlx.core as mx
    from mlx_audio.lm.models.cache import make_prompt_cache
    from mlx_audio.lm.sample_utils import make_logits_processors, make_sampler
    from mlx_audio.tts.models.chatterbox.chatterbox import SPEECH_VOCAB_SIZE, drop_invalid_tokens

    rid = req["id"]
    t3 = model.t3
    conds = conditioning(ref)
    lang = str(req.get("language", "en")).lower()
    text = prepare(req["text"], lang)
    tt = model._tokenize_text(text, lang)
    if CFG_WEIGHT > 0.0:
        tt = mx.concatenate([tt, tt], axis=0)
    sot, eot = t3.hp.start_text_token, t3.hp.stop_text_token
    tt = mx.concatenate(
        [mx.full((tt.shape[0], 1), sot, dtype=mx.int32), tt, mx.full((tt.shape[0], 1), eot, dtype=mx.int32)], axis=1
    )
    max_new = int(25 * expected_seconds(text) * 1.25)
    embeds = t3._prepare_inference_context(t3_cond=conds.t3, text_tokens=tt, cfg_weight=CFG_WEIGHT)
    cache = make_prompt_cache(t3.tfmr)
    sampler = make_sampler(temp=TEMPERATURE, top_p=1.0, min_p=0.05)
    processors = make_logits_processors(
        logit_bias=None, repetition_penalty=REPETITION_PENALTY, repetition_context_size=max_new
    )
    ids = [t3.hp.start_speech_token]
    hidden = t3.tfmr.model(inputs=None, input_embeddings=embeds, cache=cache)

    # Accounting is in absolute samples from the first token: the vocoder's
    # output is exactly SAMPLES_PER_TOKEN per token (measured window by
    # window), so where a window's audio sits in the utterance is known from
    # its first token alone.
    state = {"pos": 0, "tail": None, "segment": 0, "seconds": 0.0}

    def vocode(tokens, final):
        st = mx.array([tokens], dtype=mx.int32)
        st = drop_invalid_tokens(st[0:1])
        mask = st < SPEECH_VOCAB_SIZE
        n = int(mx.sum(mask.astype(mx.int32)))
        st = mx.expand_dims(mx.take(st, mx.argsort(-mask.astype(mx.int32))[:n]), 0)
        mx.random.seed(VOCODE_SEED)  # the same noise for the same window shape, every segment
        wav = model.s3gen(speech_tokens=st, ref_dict=conds.gen, finalize=final)
        mx.eval(wav)
        mx.random.seed(VOCODE_SEED + 1 + state["segment"])  # and a fresh stream for the sampler
        return np.asarray(wav, dtype=np.float32).reshape(-1)

    def emit(final):
        speech = ids[1:]
        pos = state["pos"]
        start = max(0, pos // SAMPLES_PER_TOKEN - STREAM_CONTEXT_TOKENS) if STREAM_CONTEXT_TOKENS > 0 else 0
        wav = vocode(speech[start:], final)
        base = start * SAMPLES_PER_TOKEN
        rel = pos - base  # where the audio not yet emitted begins in this window
        if rel >= wav.size and not final:
            return
        # The first CROSSFADE samples after `pos` were held back last time as
        # the tail; they are vocoded again here, from fresh noise, and blended
        # with the kept copy, at the offset where the two actually fit.
        blend = CROSSFADE if state["tail"] is not None and rel >= SEAM_SEARCH and wav.size >= rel + CROSSFADE + SEAM_SEARCH else 0
        offset = align_seam(state["tail"], wav, rel) if blend else 0
        new = wav[rel + offset:]
        if blend:
            ramp = np.linspace(0.0, 1.0, blend, dtype=np.float32)
            new = new.copy()
            new[:blend] = state["tail"] * (1.0 - ramp) + new[:blend] * ramp
        if os.environ.get("CLAUDE_CODE_TTS_SEAM_DEBUG"):
            print(json.dumps({"seam": state["segment"], "start": start, "pos": pos, "window_tokens": len(speech) - start,
                              "wav": int(wav.size), "expected_wav": (len(speech) - start - (0 if final else 3)) * SAMPLES_PER_TOKEN,
                              "rel": int(rel), "blend": int(blend), "offset": int(offset), "final": final}), file=sys.stderr, flush=True)
        if final:
            part = new
            state["tail"] = None
        else:
            keep = CROSSFADE + END_MARGIN
            if new.size <= keep:
                return
            part = new[:-keep]
            state["tail"] = new[-keep:-keep + CROSSFADE]  # the 30 ms right after the part
        state["pos"] = base + rel + offset + part.size
        if part.size:
            state["seconds"] += part.size / SR
            on_part(part, final)
        elif final:
            on_part(part, True)
        state["segment"] += 1

    next_at = STREAM_FIRST_TOKENS
    for step in range(max_new):
        if is_cancelled(rid):
            raise Cancelled()
        logits = t3.speech_head(hidden[:, -1:, :]).squeeze(1)
        if CFG_WEIGHT > 0.0 and logits.shape[0] > 1:
            logits = logits[0:1] + CFG_WEIGHT * (logits[0:1] - logits[1:2])
        else:
            logits = logits[0:1]
        for processor in processors:
            logits = processor(mx.array([ids], dtype=mx.int32), logits)
        nxt = sampler(logits)
        mx.eval(nxt)
        tid = int(nxt[0])
        if tid == t3.hp.stop_speech_token:
            break
        ids.append(tid)
        emb = t3.speech_emb(mx.array([[tid]])) + t3.speech_pos_emb.get_fixed_embedding(step + 1)
        if CFG_WEIGHT > 0.0:
            emb = mx.concatenate([emb, emb], axis=0)
        hidden = t3.tfmr.model(inputs=None, input_embeddings=emb, cache=cache)
        mx.eval(hidden)
        if len(ids) - 1 >= next_at:
            emit(False)
            next_at += STREAM_NEXT_TOKENS
            if state["seconds"] > expected_seconds(text):
                print(json.dumps({"runaway": True, "text": text[:60], "produced": round(state["seconds"], 1)}), file=sys.stderr, flush=True)
                break
    emit(True)


# Warm up before reporting ready: the first generation in a process pays for
# kernel compilation (several seconds).
try:
    _warm = {"text": "Ready.", "lang_code": "en", "cfg_weight": CFG_WEIGHT}
    if cfg.get("ref_audio"):
        _warm["conds"] = conditioning(cfg["ref_audio"])
    for _ in model.generate(**_warm):
        pass
except Exception as e:  # never block readiness on the warm-up
    print(json.dumps({"warmup_error": str(e)}), file=sys.stderr, flush=True)

def stream_request(req, waited):
    """Serve one request by streaming. Returns True when it answered (even
    with an error), False when streaming is unavailable and the whole-chunk
    path should serve the request instead."""
    global _stream_fallback_logged
    rid = req["id"]
    ref = req["ref_audio"] if "ref_audio" in req else cfg.get("ref_audio")
    if not ref:
        return False  # the whole path reports the missing reference
    base = req["out"][:-4] if req["out"].endswith(".wav") else req["out"]
    parts = []
    t_gen = time.time()
    first = {"at": None}

    def on_part(audio, final):
        if not parts:
            audio = trim_leading(audio, SR)
        if final:
            audio = trim_trailing(audio, SR)
        path = f"{base}.p{len(parts)}.wav"
        write_wav(path, audio, SR, req.get("gain"))
        parts.append(path)
        if first["at"] is None:
            first["at"] = time.time() - t_gen
        print(json.dumps({"id": rid, "part": path, "final": final}), flush=True)

    try:
        stream_generate(req, ref, on_part)
    except Cancelled:
        for path in parts:
            try:
                os.unlink(path)
            except OSError:
                pass
        print(json.dumps({"id": rid, "ok": False, "error": "cancelled"}), flush=True)
        return True
    except Exception as e:  # API drift, or anything else: fall back, once loudly
        if parts:
            # Some audio already went out; the rest cannot be streamed, so
            # close the stream with what exists rather than repeat the words.
            print(json.dumps({"stream_error": str(e), "parts": len(parts)}), file=sys.stderr, flush=True)
            print(json.dumps({"id": rid, "ok": False, "error": f"streaming failed after {len(parts)} parts: {e}"}), flush=True)
            return True
        if not _stream_fallback_logged:
            _stream_fallback_logged = True
            print(json.dumps({"stream_fallback": f"{type(e).__name__}: {e}"}), file=sys.stderr, flush=True)
        return False
    gen = time.time() - t_gen
    seconds = sum(os.path.getsize(p) - 44 for p in parts) / 2.0 / SR
    print(
        json.dumps({
            "request": rid, "priority": req.get("priority", 0), "stream": True, "waited_s": round(waited, 2),
            "first_part_s": round(first["at"] or 0.0, 2), "gen_s": round(gen, 2), "audio_s": round(seconds, 2),
            "rtf": round(gen / max(seconds, 0.01), 2), "text": req.get("text", "")[:40],
        }),
        file=sys.stderr, flush=True,
    )
    print(json.dumps({"id": rid, "ok": True, "gen_s": round(gen, 2), "audio_s": round(seconds, 2)}), flush=True)
    return True


_phase("warmed up")
threading.Thread(target=reader, daemon=True).start()
print(json.dumps({"ready": True, "runtime": "mlx", "model": MODEL_ID}), flush=True)

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
        # Per-request timing to the log: how long the request waited in the
        # queue and how long generation took for how much speech. This is
        # what makes a silent gap between chunks diagnosable after the fact.
        waited = time.time() - req.get("_queued_at", time.time())
        t_gen = time.time()
        if "convert" in req:
            # Same rule as generation: an explicit key wins, null included.
            ref = req["ref_audio"] if "ref_audio" in req else cfg.get("ref_audio")
            if not ref:
                raise RuntimeError("voice conversion needs a reference voice")
            audio = convert_voice(req["convert"], ref)
            sr = SR
        elif req.get("stream") and stream_request(req, waited):
            continue
        else:
            results = list(model.generate(**gen_kwargs(req)))
            if not results:
                raise RuntimeError("no audio produced")
            audio = np.concatenate([np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in results])
            sr = getattr(results[0], "sample_rate", SR) or SR
        gen = time.time() - t_gen
        print(
            json.dumps({
                "request": rid, "priority": req.get("priority", 0), "convert": "convert" in req, "waited_s": round(waited, 2),
                "gen_s": round(gen, 2), "audio_s": round(audio.size / sr, 2),
                "rtf": round(gen / max(audio.size / sr, 0.01), 2), "text": req.get("text", req.get("convert", ""))[:40],
            }),
            file=sys.stderr, flush=True,
        )
        if "text" in req:  # converted speech is as long as its source; only generation can run away
            limit = int(expected_seconds(req["text"]) * sr)
            if audio.size > limit:
                print(
                    json.dumps({"runaway": True, "text": req["text"][:60], "produced": round(audio.size / sr, 1)}),
                    file=sys.stderr,
                    flush=True,
                )
                audio = audio[:limit]
        out = req["out"]
        write_wav(out, trim(audio, sr), sr, req.get("gain"))
        print(json.dumps({"id": rid, "part": out, "final": True}), flush=True)
        # gen_s/audio_s let the extension learn this machine's real speed.
        print(json.dumps({"id": rid, "ok": True, "gen_s": round(gen, 2), "audio_s": round(audio.size / sr, 2)}), flush=True)
    except Exception as e:  # keep serving after a bad request
        print(json.dumps({"id": rid, "ok": False, "error": str(e)}), flush=True)
