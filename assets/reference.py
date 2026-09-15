# The reference recording of a cloned voice, as the model should hear it.
#
# A pause inside the reference longer than about half a second teaches the
# model that silence is followed by the end of speech: with a designed voice
# whose passage rendered with two pauses of 0.7 and 0.85 s between its
# sentences, four sentences in ten ended after two frames (0.16 s of audio,
# the sentence swallowed), and with those pauses shortened to 0.3 s, none in
# thirty-two (measured on Qwen3-TTS 0.6B; the words are untouched, so the
# transcript still matches). The daemons pass the condensed copy to the
# model and leave the profile's own file alone.
import hashlib
import os
import tempfile
import wave

import numpy as np

MAX_PAUSE = 0.4  # a silence longer than this is shortened ...
PAUSE = 0.3  # ... to this
EDGE = 0.15  # silence kept before the first word and after the last
WINDOW = 0.05  # of the envelope that decides what is silent
FLOOR = 0.01  # full-scale fraction below which the envelope is silence


def condense(samples, sr):
    """
    int16 samples with every long silence shortened and the edges trimmed;
    the samples unchanged, and 0, when there is nothing to shorten. Returns
    (samples, pauses shortened, seconds removed).
    """
    x = samples.astype(np.float32) / 32768.0
    win = max(1, int(sr * WINDOW))
    env = np.sqrt(np.convolve(x * x, np.ones(win, dtype=np.float32) / win, mode="same"))
    silent = env < FLOOR
    keep = np.ones(len(x), dtype=bool)
    pauses = 0
    i = 0
    n = len(x)
    while i < n:
        if not silent[i]:
            i += 1
            continue
        j = i
        while j < n and silent[j]:
            j += 1
        length = (j - i) / sr
        if i == 0 or j == n:
            if length > EDGE:
                if i == 0:
                    keep[: j - int(sr * EDGE)] = False
                else:
                    keep[i + int(sr * EDGE) :] = False
                pauses += 1
        elif length > MAX_PAUSE:
            keep[i + int(sr * PAUSE) : j] = False
            pauses += 1
        i = j
    if pauses == 0:
        return samples, 0, 0.0
    return samples[keep], pauses, float((~keep).sum()) / sr


def condensed_reference(path):
    """
    The path of a condensed copy of the 16-bit mono PCM WAV at `path` in the
    temp directory (made once per file version), or `path` itself when it
    has nothing to shorten or is not such a file. Returns (path, note): the
    note says what changed, or is None.
    """
    try:
        st = os.stat(path)
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                return path, None
            sr = w.getframerate()
            samples = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    except Exception:
        return path, None
    condensed, pauses, removed = condense(samples, sr)
    if pauses == 0:
        return path, None
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_mtime_ns}|{st.st_size}".encode("utf-8")).hexdigest()[:16]
    out = os.path.join(tempfile.gettempdir(), f"claude-code-tts-ref-{key}.wav")
    if not os.path.exists(out):
        tmp = f"{out}.{os.getpid()}.tmp"
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(condensed.astype("<i2").tobytes())
        os.replace(tmp, out)
    note = f"reference {os.path.basename(os.path.dirname(path))}: {pauses} silence(s) shortened, {removed:.2f} s removed ({len(samples) / sr:.1f} s to {len(condensed) / sr:.1f} s)"
    return out, note
