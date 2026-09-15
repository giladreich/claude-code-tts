# Persistent Qwen3-TTS synthesis daemon for the Claude Code TTS VSCode extension.
#
# Loads the model once (a 0.6B/1.7B torch model must never reload per
# sentence), then serves synthesis requests over stdio:
#   stdin:  {"id": 1, "text": "...", "voice": "Ryan", "language": "English", "out": "/tmp/x.wav"}\n
#   stdout: {"id": 1, "ok": true}\n  (after the WAV is fully written)
# Requests queued together are generated together: the talker's step costs
# the same for several sequences as for one, so the chunks the extension
# prepares ahead ride along with the one it is waiting for, each answered
# under its own id.
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
from reference import condensed_reference
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
    # Long pauses inside the reference made the model end sentences after
    # two frames (see reference.py); the model hears a condensed copy.
    audio, note = condensed_reference(ref_audio)
    if note:
        print(note, file=sys.stderr, flush=True)
    prompts[key] = model.create_voice_clone_prompt(ref_audio=audio, ref_text=ref_text)
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
    qwen3_fast.install(model, log=lambda s: print(s, file=sys.stderr, flush=True), graphs=cfg.get("graphs", True), rows=8)
# The codec decoder runs in float32: a stream is decoded prefix by prefix,
# and in bfloat16 two decodes of the same frames differed by up to 0.014
# (a faint click at every seam); in float32 by 0.0006. It is a small model,
# 134 ms for seven seconds of audio against 49.
try:
    qwen3_fast.decoder_module(model).float()
except Exception as e:
    print(f"codec decoder kept in its own precision ({type(e).__name__}: {e})", file=sys.stderr, flush=True)
SAMPLE_RATE = 24000
# The codec decoder run with its state kept between parts (see
# qwen3_fast.StreamDecoder): each part costs its own frames, where decoding
# the whole prefix again cost the prefix and the voice reference every time.
# A voice's reference is pushed through once and the state copied per
# utterance. Without it (a runtime whose decoder is built differently) each
# part is a whole-prefix decode, as before.
try:
    qwen3_fast.stream_decoder(model)
    STREAM_DECODE = True
except Exception as e:
    STREAM_DECODE = False
    print(f"streaming decoder unavailable ({type(e).__name__}: {e}); parts are whole-prefix decodes", file=sys.stderr, flush=True)
primed = collections.OrderedDict()


def decoder_for(ref_codes):
    """A fresh decoder state for an utterance: primed with the clone's reference, or empty for a preset."""
    if not STREAM_DECODE:
        return None
    if ref_codes is None:
        return qwen3_fast.stream_decoder(model)
    key = id(ref_codes)
    if key not in primed:
        dec = qwen3_fast.stream_decoder(model)
        with torch.inference_mode():
            dec.feed(ref_codes)
        primed[key] = (ref_codes, dec)  # the codes kept alive, so the id stays theirs
        while len(primed) > PROMPT_CACHE:
            primed.popitem(last=False)
    primed.move_to_end(key)
    return primed[key][1].copy()


# The runtime decodes every row of a generation once more when it ends,
# audio nothing reads any more: the parts and the whole come from the
# streaming decoder above. Stubbed out for the duration of a generation;
# the fallback decode keeps the original to call.
_tokenizer = getattr(getattr(model, "model", model), "speech_tokenizer")
WHOLE_DECODE = _tokenizer.decode


class NoFinalDecode:
    def __enter__(self):
        if STREAM_DECODE:
            _tokenizer.decode = lambda items, *a, **k: ([np.zeros(0, dtype=np.float32) for _ in items], SAMPLE_RATE)

    def __exit__(self, *_):
        _tokenizer.decode = WHOLE_DECODE
        return False
# Requests are read on a thread: {"cancel": id} drops a queued request, or
# the row of a running generation (seen at its next frame); "priority": 1
# requests are served before queued prewarm work; {"hot": id} says the
# request is being played now, so its row hands out what it has and then a
# part a second.
urgent, background = [], []
cancelled = collections.OrderedDict()  # cancelled request ids, oldest first
hot = set()


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
            elif "hot" in req:
                hot.add(req["hot"])
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


def is_cancelled(rid):
    with cv:
        return rid in cancelled


def clone_prompt_for(req):
    ref_audio = req.get("ref_audio") or (clone or {}).get("ref_audio")
    ref_text = req.get("ref_text") or (clone or {}).get("ref_text")
    return prompt_for(ref_audio, ref_text) if ref_audio and ref_text else None


def ref_codes_of(prompt):
    """
    The reference's codec frames, which go in front of a clone's frames
    for the decoder, as the reference implementation does it: without them
    the streamed parts decoded to other audio than the whole utterance
    (measured 0.30 peak difference in the first second, 0.15 in the
    second, on a 0.15 RMS signal) and the voice changed at the seam. The
    newer runtime hands the prompt out as a list of items, the older as a
    dict.
    """
    if prompt is None:
        return None
    if isinstance(prompt, dict):
        ref_list = prompt.get("ref_code")
        return ref_list[0] if ref_list and ref_list[0] is not None else None
    if isinstance(prompt, (list, tuple)) and prompt:
        return getattr(prompt[0], "ref_code", None)
    return None


def generate(reqs, **extra):
    """One generation for every request in `reqs`: the talker's step costs
    the same for eight sequences as for one (measured: seven sentences in
    1.1x the time of one), so the chunks prepared ahead ride along with the
    one being waited for."""
    texts = [r["text"] for r in reqs]
    languages = [r.get("language", "English") for r in reqs]
    prompts = [clone_prompt_for(r) for r in reqs]
    if prompts[0] is not None:
        if len(reqs) == 1:
            # The batched form is ~3.5x faster than scalar in qwen-tts.
            try:
                return model.generate_voice_clone(text=texts, language=languages, voice_clone_prompt=prompts[0], **extra)
            except (TypeError, ValueError):
                return model.generate_voice_clone(
                    text=texts[0], language=languages[0], voice_clone_prompt=prompts[0], **extra
                )
        items = []
        for p in prompts:
            items.extend(p)
        return model.generate_voice_clone(text=texts, language=languages, voice_clone_prompt=items, **extra)
    kwargs = {"text": texts, "language": languages, "speaker": [r.get("voice", "Ryan") for r in reqs], **extra}
    if any(r.get("style") for r in reqs):
        kwargs["instruct"] = [str(r.get("style") or "") for r in reqs]
    return model.generate_custom_voice(**kwargs)


def write_wav(path, samples, sr, gain):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(to_pcm16(samples, gain))


# 12 Hz frames: the first part goes out after this many, the rest every
# CHUNK_FRAMES. Half a second is enough to start speaking on; a second per
# part keeps the decoder (a whole-prefix decode each time) cheap. The other
# rows of a batch are for later: each part is a decode of the row's whole
# prefix, and decoding every row every second measured as much time as the
# generation itself, so they hand out a part every AHEAD_FRAMES until the
# extension says one is being played, which promotes it to the pace above.
FIRST_FRAMES = 6
CHUNK_FRAMES = 12
AHEAD_FRAMES = 36
FRAME_RATE = 12.5  # 24 kHz at 1920 samples per frame, measured on the reference decoder
END_BREATH = 0.3  # silence closing a stream: the breath before the next utterance
# Requests generated together. The chunks the extension prepares ahead arrive
# within milliseconds of the one it is waiting for, so a short wait gathers
# a whole message into one generation.
MAX_BATCH = 8 if not clone or isinstance(prompt_for(clone["ref_audio"], clone["ref_text"]), list) else 1
GATHER_SECONDS = 0.05


class Done(Exception):
    """Raised inside the talker's step when no row needs another frame: a cut or a cancel ended the last one."""


class BatchUnsupported(Exception):
    """The runtime refused a generation of several requests before making a frame: they are generated one at a time."""


class Row:
    """One request's state through a batched generation."""

    def __init__(self, req, hot):
        self.req = req
        self.rid = req["id"]
        self.text = req["text"]
        self.gain = float(req.get("gain", GAIN))
        self.out = req["out"]
        self.streaming = bool(req.get("stream"))
        self.base = self.out[:-4] if self.out.lower().endswith(".wav") else self.out
        self.ref_codes = ref_codes_of(clone_prompt_for(req))
        self.limit_seconds = expected_seconds(self.text)
        self.limit_frames = int(self.limit_seconds * FRAME_RATE + FRAME_RATE)
        self.pause_scale = float(req.get("pause_scale", 1.0))
        self.frames = []
        self.parts = []
        self.emitted = 0
        self.decoder = decoder_for(self.ref_codes)
        self.decoded = 0  # frames the streaming decoder has been fed
        self.samples = 0  # audio samples handed out, for the log
        self.cadence = CHUNK_FRAMES if hot else AHEAD_FRAMES
        self.next = FIRST_FRAMES if hot else self.cadence
        self.done = False
        self.cut = False
        self.cancelled = False

    def audio_since_last(self):
        """The samples for the frames not yet handed out."""
        global STREAM_DECODE
        if self.decoder is not None:
            try:
                new = self.frames[self.decoded :]
                if not new:
                    return np.zeros(0, dtype=np.float32), SAMPLE_RATE
                with torch.inference_mode():
                    samples = self.decoder.feed(torch.stack(new))
                self.decoded = len(self.frames)
                return samples.detach().float().cpu().numpy(), SAMPLE_RATE
            except Exception as e:
                # From here on, this row and the next ones decode their whole prefix per part, as before.
                STREAM_DECODE = False
                self.decoder = None
                print(f"streaming decoder failed ({type(e).__name__}: {e}); parts are whole-prefix decodes", file=sys.stderr, flush=True)
        if not self.frames:
            return np.zeros(0, dtype=np.float32), SAMPLE_RATE
        full_wav, sr = qwen3_fast.decode_codes(model, torch.stack(self.frames), self.ref_codes, decode=WHOLE_DECODE)
        part = full_wav[self.emitted :]
        self.emitted = len(full_wav)
        return part, sr

    def emit(self, final):
        part, sr = self.audio_since_last()
        if final:
            part = np.concatenate([part, np.zeros(int(sr * END_BREATH * self.pause_scale), dtype=np.float32)])
        elif part.size == 0:
            return
        path = f"{self.base}.p{len(self.parts)}.wav"
        write_wav(path, part, sr, self.gain)
        self.parts.append(path)
        self.samples += len(part)
        self.next = len(self.frames) + self.cadence
        print(json.dumps({"id": self.rid, "part": path, "final": final}), flush=True)

    def write_whole(self):
        """A request without streaming: the whole utterance to `out`."""
        part, sr = self.audio_since_last()
        write_wav(self.out, part, sr, self.gain)
        self.samples += len(part)

    def promote(self):
        """Being played now: what it has at once, then a part a second."""
        self.cadence = CHUNK_FRAMES
        if self.streaming and not self.done and len(self.frames) >= FIRST_FRAMES:
            self.emit(False)
        self.next = min(self.next, len(self.frames) + self.cadence)

    def cancel(self):
        self.cancelled = True
        self.done = True
        for p in self.parts:
            try:
                os.unlink(p)
            except OSError:
                pass
        self.parts = []
        print(json.dumps({"id": self.rid, "ok": False, "error": "cancelled"}), flush=True)


def synthesize(reqs):
    """
    One batch: each request's whole utterance to its `out`, or, with
    "stream": true, parts handed out as the talker makes its frames (the
    codec decoder is causal, so a prefix of the frames decodes to the very
    audio the whole utterance decodes to over those frames). The first row
    is the one being waited for and streams every second; the others are
    for later. A cancel lands inside the talker's step and drops that row
    (the generation ends when no row is left); the runaway cutoff is the
    token budget the row's text can plausibly need.
    """
    rows = [Row(req, i == 0) for i, req in enumerate(reqs)]
    eos = qwen3_fast.eos_token_id(model)

    t0 = time.time()

    def finish(row):
        """The row's whole audio, the moment its last frame is in: the rows
        of a batch end at different times, and the first one's listener
        must not wait for the longest one's tail."""
        row.done = True
        if row.streaming:
            row.emit(True)
        else:
            row.write_whole()
        seconds = row.samples / float(SAMPLE_RATE)
        if row.cut or seconds > row.limit_seconds + END_BREATH * row.pause_scale:
            print(json.dumps({"runaway": True, "text": row.text[:60], "produced": round(seconds, 1)}), file=sys.stderr, flush=True)
        gen = time.time() - t0
        print(json.dumps({"request": row.rid, "batch": len(rows), "gen_s": round(gen, 2), "audio_s": round(seconds, 2), "rtf": round(gen / max(seconds, 0.01), 2), "parts": len(row.parts), "text": row.text[:40]}), file=sys.stderr, flush=True)
        print(json.dumps({"id": row.rid, "ok": True, "gen_s": round(gen, 2), "audio_s": round(seconds, 2)}), flush=True)

    def on_frame(codec_ids):
        with cv:
            promoted = [row for row in rows if row.rid in hot]
            for row in promoted:
                hot.discard(row.rid)
        collecting = False
        for i, row in enumerate(rows):
            if row.done:
                continue
            if is_cancelled(row.rid):
                row.cancel()
                continue
            if row in promoted:
                row.promote()
            if eos is not None and int(codec_ids[i, 0]) == eos:
                finish(row)
                continue
            if len(row.frames) >= row.limit_frames:
                row.cut = True
                finish(row)
                continue
            row.frames.append(codec_ids[i].detach())
            collecting = True
            if row.streaming and len(row.frames) >= row.next:
                row.emit(False)
        # The runtime stops on its own once every row has said its end; a
        # row cut or cancelled would keep it generating for nobody.
        if not collecting and any(r.cut or r.cancelled for r in rows):
            raise Done()

    try:
        with qwen3_fast.FrameTap(model, on_frame), NoFinalDecode():
            # No autograd bookkeeping for a model that is only ever read: the
            # graph it would build per token is memory the next sentence needs.
            with torch.inference_mode():
                generate(reqs, max_new_tokens=max(r.limit_frames for r in rows))
    except Done:
        pass
    except qwen3_fast.Cancelled:
        pass
    except Exception as e:
        if len(rows) > 1 and not any(r.parts or r.frames for r in rows):
            raise BatchUnsupported(e)
        raise
    # A row the token budget stopped before its end, or one whose end
    # arrived with the runtime's own last step.
    for row in rows:
        if row.done:
            continue
        if is_cancelled(row.rid):
            row.cancel()
        else:
            finish(row)


# The first generation on a GPU is slow (the kernels load, cuBLAS and cudnn
# settle, the predictor's graph is recorded: measured twice the time of the
# second), so it is spent here on a throwaway text, before the daemon says
# it is ready, rather than on the first sentence someone waits for. On the
# CPU there is nothing to settle and the same generation would only delay
# the ready line by the seconds it takes.
if device != "cpu":
    try:
        warm = {"text": "Ready.", "language": "Auto"}
        if clone:
            warm.update(ref_audio=clone["ref_audio"], ref_text=clone["ref_text"])
        else:
            warm["voice"] = "Ryan"
        with torch.inference_mode(), NoFinalDecode():
            generate([warm], max_new_tokens=30)
    except Exception as e:
        print(f"warm-up skipped ({type(e).__name__}: {e})", file=sys.stderr, flush=True)
print(json.dumps({"ready": True, "device": device, "mode": "clone" if clone else "preset"}), flush=True)


def next_batch():
    """The next requests to generate together: the urgent one first, then
    what is queued behind it, of the same kind (a clone request and a preset
    one cannot share a generation), up to MAX_BATCH."""
    with cv:
        while not urgent and not background and not eof:
            cv.wait()
        if not urgent and not background:
            return None
        deadline = time.time() + GATHER_SECONDS
        while len(urgent) + len(background) < MAX_BATCH:
            left = deadline - time.time()
            if left <= 0:
                break
            cv.wait(left)
        batch = []
        while (urgent or background) and len(batch) < MAX_BATCH:
            queue = urgent if urgent else background
            if batch and ("ref_audio" in queue[0]) != ("ref_audio" in batch[0]):
                break
            batch.append(queue.pop(0))
        return batch


while True:
    batch = next_batch()
    if batch is None:
        break
    live = []
    for req in batch:
        with cv:
            skip = req["id"] in cancelled
            cancelled.pop(req["id"], None)
        if skip:
            print(json.dumps({"id": req["id"], "ok": False, "error": "cancelled"}), flush=True)
        else:
            live.append(req)
    if not live:
        continue
    try:
        try:
            synthesize(live)
        except BatchUnsupported as e:
            MAX_BATCH = 1
            print(f"batching failed ({type(e.args[0]).__name__}: {e.args[0]}); one request per generation from now on", file=sys.stderr, flush=True)
            for req in live:
                synthesize([req])
    except Exception as e:  # keep serving after a bad request
        for req in live:
            print(json.dumps({"id": req["id"], "ok": False, "error": str(e)}), flush=True)
    finally:
        with cv:
            for req in live:
                cancelled.pop(req["id"], None)
                hot.discard(req["id"])
