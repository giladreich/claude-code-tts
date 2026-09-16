"""Render notification sounds with Stable Audio Open Small from a prompt table.

    python scripts/sounds/generate.py assets/sounds/prompts.json assets/sounds      # the shipped set, again
    python scripts/sounds/generate.py my-prompts.json sound-candidates/mine        # candidates to audition
    python scripts/sounds/generate.py --index assets/sounds/prompts.json assets/sounds   # only index.json, from the wavs there

The table is a JSON list of {"file", "prompt", "seed", "event"?, "default"?, "leveling"?, "seconds_total"?}. Every
entry is rendered with the same settings the shipped set was (8 steps, the pingpong sampler, cfg 1), trimmed of
leading silence, levelled ("RMS 0.16, peak at most 0.95" for chimes, "peak 0.9" for short cues) and written as
24 kHz mono 16-bit WAV. Entries that name an event are listed in an index.json beside the files, which the
extension's sound picker reads: "builtin/<file stem>", a label from the event and the prompt, the length, and
whether the sound is the event's default. The model is gated: accept its license at
huggingface.co/stabilityai/stable-audio-open-small and `hf auth login` first. Needs a Python with torch (CUDA),
stable-audio-tools (installed with --no-deps, its training pins do not resolve), einops-exts, x-transformers,
transformers, sentencepiece, alias-free-torch, vector-quantize-pytorch, local-attention, k-diffusion, laion-clap,
torchmetrics, auraloss, descript-audio-codec, pedalboard, aeiou, prefigure, PyWavelets, scipy and soundfile.
"""
import json, os, sys, time, wave
from math import gcd

import numpy as np

MODEL = "stabilityai/stable-audio-open-small"
SR_OUT = 24000


def seconds_of(path):
    with wave.open(path, "rb") as w:
        return round(w.getnframes() / w.getframerate(), 2)


def write_index(entries, out):
    """index.json for the entries that name an event: what the extension's picker shows for each file."""
    index = []
    for e in entries:
        if not e.get("event"):
            continue
        stem = os.path.splitext(e["file"])[0]
        event = e["event"]
        title = event[0].upper() + event[1:]
        # "done" is the default, "done-3" the third alternative
        number = stem[len(event) + 1 :] if stem.startswith(event + "-") else ""
        first = e["prompt"].split(",")[0].strip()
        summary = first[0].upper() + first[1:]
        index.append({
            "value": f"builtin/{stem}",
            "label": f"{title} {number}: {summary}" if number else f"{title}: {summary}",
            "detail": f"{seconds_of(os.path.join(out, e['file']))} s" + (", the default" if e.get("default") else ""),
            "group": title,
            "event": event,
        })
    if index:
        with open(os.path.join(out, "index.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(index, f, indent=2)
            f.write("\n")


def post(audio, sr, leveling, seconds_total, resample_poly):
    x = audio.float().cpu().numpy().mean(0)
    g = gcd(SR_OUT, sr)
    x = resample_poly(x, SR_OUT // g, sr // g)
    floor = -45 if leveling.startswith("peak") else -50
    thr = 10 ** (floor / 20) * max(1e-9, np.abs(x).max())
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx):
        x = x[max(0, idx[0] - int(SR_OUT * 0.03)) : min(len(x), idx[-1] + int(SR_OUT * 0.05))]
    if seconds_total:
        x = x[: int(SR_OUT * (seconds_total + 0.5))]
    x = x - x.mean()
    if leveling.startswith("peak"):
        p = np.abs(x).max()
        if p > 0:
            x = x * (0.9 / p)
    else:
        r = np.sqrt((x * x).mean())
        if r > 0:
            x = x * (0.16 / r)
        p = np.abs(x).max()
        if p > 0.95:
            x = x * (0.95 / p)
    fade = min(len(x) // 4, int(SR_OUT * 0.02))
    if fade > 0:
        x[-fade:] *= np.linspace(1, 0, fade)
    return x


def main(table, out):
    import torch
    from scipy.signal import resample_poly
    from stable_audio_tools import get_pretrained_model
    from stable_audio_tools.inference.generation import generate_diffusion_cond

    entries = json.load(open(table, encoding="utf-8"))
    os.makedirs(out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, cfg = get_pretrained_model(MODEL)
    model = model.to(device)
    sr = cfg["sample_rate"]
    for e in entries:
        t0 = time.time()
        with torch.inference_mode():
            audio = generate_diffusion_cond(
                model, steps=8, cfg_scale=1, sampler_type="pingpong", device=device, seed=e["seed"],
                sample_size=cfg["sample_size"],
                conditioning=[{"prompt": e["prompt"], "seconds_total": e.get("seconds_total") or 2.0}],
            )
        x = post(audio[0], sr, e.get("leveling", "RMS 0.16, peak at most 0.95"), e.get("seconds_total"), resample_poly)
        with wave.open(os.path.join(out, e["file"]), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR_OUT)
            w.writeframes(np.clip(x * 32767, -32768, 32767).astype("<i2").tobytes())
        print(f"{e['file']} {len(x)/SR_OUT:.2f}s in {time.time()-t0:.1f}s", flush=True)
    write_index(entries, out)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--index"] and len(args) == 3:
        write_index(json.load(open(args[1], encoding="utf-8")), args[2])
    elif len(args) == 2:
        main(args[0], args[1])
    else:
        print(__doc__)
        sys.exit(2)
