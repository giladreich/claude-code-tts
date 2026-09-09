# Persistent Kokoro synthesis daemon for the Claude Code TTS VSCode extension.
#
# Loads the model once (the sherpa CLI reloads it per call, costing 1-2s per
# sentence), then serves synthesis requests over stdio:
#   stdin:  {"id": 1, "text": "...", "sid": 3, "speed": 1.0, "out": "/tmp/x.wav", "stream": true}\n
#   stdout: streaming -> {"id": 1, "part": "/tmp/x.p0.wav", "final": false} ... {"id": 1, "ok": true}
#           non-stream -> {"id": 1, "ok": true} after the WAV is fully written
#   {"cancel": 1} aborts request 1 (queued or mid-generation); it answers
#   {"id": 1, "ok": false, "error": "cancelled"}. Requests are read on a
#   thread so a cancel lands while the model is busy.
#   "priority": 1 marks a request the user is waiting on right now (the
#   utterance about to play, a voice preview); it is served before queued
#   look-ahead (prewarm) work. Leading silence of the first part is trimmed so
#   utterances chain tightly; streamed parts end on a reader's pause instead of
#   a trim, and whole-file output is trimmed at both ends.
# Streaming uses sherpa's generation callback: audio parts are emitted every
# ~0.4s of audio, so playback can start long before synthesis finishes.
# Runs 100% locally; no sockets, no network.
import array
import json
import os
import zlib
import queue
import sys
import threading
import wave

import sherpa_onnx

cfg = json.loads(sys.argv[1])

tts = sherpa_onnx.OfflineTts(
    sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=cfg["model"],
                voices=cfg["voices"],
                tokens=cfg["tokens"],
                data_dir=cfg["data_dir"],
                lexicon=cfg.get("lexicon", ""),
                dict_dir=cfg.get("dict_dir", ""),
            ),
            num_threads=cfg.get("num_threads", 4),
            provider="cpu",
        ),
        max_num_sentences=1,
    )
)
SR = tts.sample_rate
PART_SECONDS = 0.4
EDGE_KEEP = 0.06  # lead-in silence kept (seconds)
TAIL_KEEP = 0.35  # tail silence kept: a natural breath before the next utterance
# Kokoro renders sentences with ~0.15s of trailing silence; a reader pauses
# about 0.45s between sentences. Each sentence part is padded to that (a bit
# less at higher speeds) so the flow breathes instead of running on.
# A reader pauses differently after a full stop than after a colon, and
# never twice for exactly the same length. Both are cheap to reproduce and
# are most of what makes synthesized speech feel mechanical.
SENTENCE_PAUSE = 0.45
CLAUSE_PAUSE = 0.30
CONTINUATION_PAUSE = 0.20
END_BREATH = 0.12  # silence closing a stream (on top of the last sentence pause)


def pause_for(text, scale):
    """Pause after a sentence, from its final punctuation, with a small
    deterministic variation so a paragraph does not tick like a metronome."""
    stripped = text.rstrip()
    last = stripped[-1] if stripped else ""
    base = SENTENCE_PAUSE if last in ".!?" else CLAUSE_PAUSE if last in ":;" else CONTINUATION_PAUSE
    # +-12%, derived from the text so the same sentence always sounds the same.
    jitter = 1.0 + ((zlib.crc32(stripped.encode("utf-8")) % 25) - 12) / 100.0
    return max(0.05, base * jitter * scale)


def pad_sentence_end(samples, speed, text, scale):
    n = len(samples)
    i = n
    while i > 0 and abs(samples[i - 1]) < EDGE_THRESHOLD:
        i -= 1
    want = int(SR * pause_for(text, scale) / max(0.8, min(1.6, speed)))
    have = n - i
    return samples + [0.0] * (want - have) if have < want else samples
EDGE_THRESHOLD = 0.01


def _edge_threshold(samples):
    peak = max((abs(s) for s in samples), default=0.0)
    return max(EDGE_THRESHOLD, 0.06 * peak)


def trim_leading(samples):
    n = len(samples)
    thr = _edge_threshold(samples)
    i = 0
    while i < n and abs(samples[i]) < thr:
        i += 1
    cut = max(0, i - int(SR * EDGE_KEEP))
    return samples[cut:] if cut > 0 else samples


def trim_trailing(samples):
    n = len(samples)
    thr = _edge_threshold(samples)
    i = n
    while i > 0 and abs(samples[i - 1]) < thr:
        i -= 1
    cut = min(n, i + int(SR * TAIL_KEEP))
    return samples[:cut] if cut < n else samples


def write_wav(path, samples):
    pcm = array.array("h", (max(-32768, min(32767, int(s * 32767))) for s in samples))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


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


threading.Thread(target=reader, daemon=True).start()
print(json.dumps({"ready": True, "sample_rate": SR}), flush=True)

while True:
    req = next_request()
    if req is None:
        break
    rid = req["id"]
    if is_cancelled(rid):
        print(json.dumps({"id": rid, "ok": False, "error": "cancelled"}), flush=True)
        continue
    try:
        sid, speed = int(req["sid"]), float(req["speed"])
        pause_scale = float(req.get("pause_scale", 1.0))
        # Humans do not hold an exact pace: a couple of percent of variation
        # per chunk, fixed per text so a repeat sounds identical.
        speed *= 1.0 + ((zlib.crc32(req["text"].encode("utf-8")) % 5) - 2) / 100.0
        if req.get("stream"):
            base = req["out"][:-4] if req["out"].endswith(".wav") else req["out"]
            # Each sentence is emitted the moment it is synthesized (latency),
            # padded to a reader's pause. The stream is closed by a short
            # silence part flagged final: the breath at the end of the
            # utterance, and the marker the player needs.
            state = {"buf": [], "n": 0}

            def flush_part(final):
                if not state["buf"]:
                    return
                p = f"{base}.p{state['n']}.wav"
                samples = state["buf"]
                if state["n"] == 0:
                    samples = trim_leading(samples)
                # sherpa hands one sentence per callback, so the text that
                # decides the pause is the sentence just spoken.
                sentences = [s for s in req["text"].replace("! ", "!|").replace("? ", "?|").replace(". ", ".|").split("|") if s.strip()]
                spoken = sentences[state["n"]] if state["n"] < len(sentences) else req["text"]
                write_wav(p, pad_sentence_end(samples, speed, spoken, pause_scale))
                state["buf"] = []
                state["n"] += 1
                print(json.dumps({"id": rid, "part": p, "final": False}), flush=True)

            def cb(samples, progress):
                if is_cancelled(rid):
                    return 0  # stop generating
                state["buf"].extend(float(s) for s in samples)
                if len(state["buf"]) >= SR * PART_SECONDS:
                    flush_part(False)
                return 1  # continue generating

            try:
                tts.generate(req["text"], sid=sid, speed=speed, callback=cb)
            except Exception as e:
                # sherpa's callback path needs numpy; without it fall back to a
                # single whole-file part so playback still works.
                if "numpy" not in str(e):
                    raise
                state["buf"] = list(tts.generate(req["text"], sid=sid, speed=speed).samples)
            if is_cancelled(rid):
                for i in range(state["n"]):
                    try:
                        os.unlink(f"{base}.p{i}.wav")
                    except OSError:
                        pass
                raise RuntimeError("cancelled")
            flush_part(True)
            if state["n"] == 0:
                raise RuntimeError("no audio produced")
            tail = f"{base}.p{state['n']}.wav"
            write_wav(tail, [0.0] * int(SR * END_BREATH * pause_scale))
            print(json.dumps({"id": rid, "part": tail, "final": True}), flush=True)
            print(json.dumps({"id": rid, "ok": True}), flush=True)
        else:
            audio = tts.generate(req["text"], sid=sid, speed=speed)
            write_wav(req["out"], trim_trailing(trim_leading(list(audio.samples))))
            print(json.dumps({"id": rid, "ok": True}), flush=True)
    except Exception as e:  # keep serving after a bad request
        print(json.dumps({"id": rid, "ok": False, "error": str(e)}), flush=True)
    finally:
        with cv:
            cancelled.discard(rid)
