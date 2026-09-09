# One-shot "voice design" for the Claude Code TTS VSCode extension: turns a text
# description of a voice into a reference recording using the Qwen3-TTS
# VoiceDesign model (1.7B). The result becomes a regular clone profile, so
# everyday synthesis runs on a faster engine (the 0.6B Base model, or
# Chatterbox for the languages it speaks). Runs 100% locally; the model
# downloads from Hugging Face on first use (~4.2 GB).
#
#   argv[1] JSON: {"model_id": "...", "instruct": "...", "text": "...",
#                  "language": "English", "out": "/path/ref.wav"}
#   stdout: one JSON line {"ok": true, "seconds": 10.2} or {"ok": false, "error": "..."}
import array
import json
import os
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speech_budget import expected_seconds

cfg = json.loads(sys.argv[1])
text = cfg["text"]
# Runaway guard: ~12.5 codec tokens per second of audio. The estimate counts
# Chinese, Japanese and Korean by character, because they are written without
# spaces: counting words scored a whole passage as one, gave a budget of about
# three seconds, and the render was cut off before it had said anything, which
# the design flow reported as "the model produced almost no speech".
max_tokens = int(12.5 * expected_seconds(text, overhead=3.0, slack=1.4))


def write_wav(path, samples, sr):
    pcm = array.array("h", (max(-32768, min(32767, int(float(s) * 32767))) for s in samples))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


try:
    try:
        import numpy as np
        from mlx_audio.tts.utils import load_model

        model = load_model(cfg["model_id"])
        results = list(
            model.generate(
                text=text,
                instruct=cfg["instruct"],
                lang_code=str(cfg.get("language", "English")).lower(),
                max_tokens=max_tokens,
                repetition_penalty=1.1,
            )
        )
        audio = np.concatenate([np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in results])
        sr = results[0].sample_rate
    except ImportError:
        import torch
        from qwen_tts import Qwen3TTSModel

        device = "mps" if torch.backends.mps.is_available() else ("cuda:0" if torch.cuda.is_available() else "cpu")
        model = Qwen3TTSModel.from_pretrained(
            cfg["model_id"], device_map=device, dtype=torch.float32 if device == "cpu" else torch.bfloat16
        )
        wavs, sr = model.generate_voice_design(
            text=text, language=cfg.get("language", "English"), instruct=cfg["instruct"]
        )
        audio = wavs[0]
    write_wav(cfg["out"], audio, sr)
    print(json.dumps({"ok": True, "seconds": round(len(audio) / float(sr), 2)}), flush=True)
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}), flush=True)
    sys.exit(1)
