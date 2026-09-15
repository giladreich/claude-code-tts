# A faster inner loop for the Qwen3-TTS PyTorch runtime.
#
# The reference implementation (qwen_tts) produces one 12 Hz frame per step
# of the talker, and for each frame asks its code predictor for the frame's
# other 15 codebook tokens by calling transformers' generate() on it: a
# whole generation pass, with its logits processors, stopping criteria,
# cache allocation and per-step bookkeeping, for 15 tokens of a 4-layer
# model. Profiled on a laptop with an NVIDIA GPU that was 19.2 s of CPU for 6.6 s of
# audio, the GPU idle between tiny kernels, and speech slower than realtime
# by 2.7x on a machine that should be several times faster than it.
#
# This module replaces that one call with a plain loop over the same
# weights: one forward per token with the model's own KV cache, and the
# same sampling the reference asks for (temperature, top-k, top-p,
# multinomial) in the order transformers applies them. Nothing about the
# talker, the prompts or the codec changes, so the voice is the same; the
# tokens differ only as any two sampled runs differ. The reference path is
# kept and restored on the first exception, so a runtime this was not
# written against still speaks, only slower.
import functools

import torch


class _Result:
    """What the talker reads from the predictor's answer: `.sequences`."""

    __slots__ = ("sequences",)

    def __init__(self, sequences):
        self.sequences = sequences


def _sample(logits, do_sample, temperature, top_k, top_p):
    """One token per row of `logits`, the way transformers' _sample does it."""
    if not do_sample:
        return torch.argmax(logits, dim=-1, keepdim=True)
    logits = logits.float()
    if temperature is not None and temperature > 0 and temperature != 1.0:
        logits = logits / temperature
    if top_k is not None and 0 < top_k < logits.shape[-1]:
        kth = torch.topk(logits, top_k, dim=-1).values[..., -1, None]
        logits = logits.masked_fill(logits < kth, float("-inf"))
    if top_p is not None and 0 < top_p < 1.0:
        sorted_logits, sorted_idx = torch.sort(logits, descending=False, dim=-1)
        cumulative = sorted_logits.softmax(dim=-1).cumsum(dim=-1)
        remove = cumulative <= (1 - top_p)
        remove[..., -1] = False
        drop = remove.scatter(-1, sorted_idx, remove)
        logits = logits.masked_fill(drop, float("-inf"))
    probs = torch.softmax(logits, dim=-1)
    return torch.multinomial(probs, num_samples=1)


def _find_code_predictor(model):
    """The talker's code predictor, wherever the wrapper keeps the talker."""
    for owner in (model, getattr(model, "model", None)):
        talker = getattr(owner, "talker", None)
        predictor = getattr(talker, "code_predictor", None)
        if predictor is not None and hasattr(predictor, "generate") and hasattr(predictor, "lm_head"):
            return predictor
    return None


def install(model, log=lambda s: None):
    """
    Replace the code predictor's generate() on `model` (a qwen_tts
    Qwen3TTSModel) with the loop above. Returns True when installed; the
    original is put back by the loop itself the first time it fails.
    """
    predictor = _find_code_predictor(model)
    if predictor is None:
        log("fast path: no code predictor found on this runtime; reference generation kept")
        return False
    original = predictor.generate
    groups = len(predictor.lm_head)

    def fast_generate(inputs_embeds=None, max_new_tokens=None, do_sample=True, top_p=1.0, top_k=50, temperature=0.9, **_):
        steps = int(max_new_tokens) if max_new_tokens else groups
        try:
            with torch.inference_mode():
                out = predictor(inputs_embeds=inputs_embeds, use_cache=True, return_dict=True)
                cache = out.past_key_values
                token = _sample(out.logits[:, -1, :], do_sample, temperature, top_k, top_p)
                tokens = [token]
                for step in range(1, steps):
                    out = predictor(
                        input_ids=token, past_key_values=cache, use_cache=True, generation_steps=step, return_dict=True
                    )
                    cache = out.past_key_values
                    token = _sample(out.logits[:, -1, :], do_sample, temperature, top_k, top_p)
                    tokens.append(token)
            return _Result(torch.cat(tokens, dim=-1))
        except Exception as e:  # any surprise: the reference path, from now on
            predictor.generate = original
            log(f"fast path failed ({type(e).__name__}: {e}); reference generation restored")
            return original(
                inputs_embeds=inputs_embeds,
                max_new_tokens=max_new_tokens,
                do_sample=do_sample,
                top_p=top_p,
                top_k=top_k,
                temperature=temperature,
                output_hidden_states=True,
                return_dict_in_generate=True,
            )

    predictor.generate = fast_generate
    log(f"fast path: code predictor sampled directly ({groups} codebooks per frame)")
    return True


class Cancelled(Exception):
    """Raised inside the talker's step when the request was cancelled: it ends generation at once."""


def _find_talker(model):
    for owner in (model, getattr(model, "model", None)):
        talker = getattr(owner, "talker", None)
        if talker is not None and hasattr(talker, "forward"):
            return talker
    return None


class FrameTap:
    """
    Reports every frame the talker finishes while a generation runs.

    The talker's forward returns each step's codec ids (all codebooks of the
    frame just completed) in its `hidden_states`; wrapping the bound forward
    for the duration of one generation is enough to see them as they are
    made, which is what lets audio be decoded and played before the whole
    utterance exists. Used as a context manager; `on_frame` receives a
    [batch, codebooks] tensor and may raise Cancelled.
    """

    def __init__(self, model, on_frame):
        self.talker = _find_talker(model)
        self.on_frame = on_frame

    def __enter__(self):
        talker = self.talker
        if talker is None:
            return self
        original = talker.forward
        on_frame = self.on_frame

        # transformers inspects forward's signature to validate its kwargs;
        # the wrapper has to show the original's.
        @functools.wraps(original)
        def forward(*args, **kwargs):
            out = original(*args, **kwargs)
            hidden = getattr(out, "hidden_states", None)
            if isinstance(hidden, tuple) and len(hidden) == 2 and hidden[1] is not None:
                on_frame(hidden[1])
            return out

        talker.forward = forward
        return self

    def __exit__(self, *_):
        if self.talker is not None:
            try:
                del self.talker.forward  # the class method shows through again
            except AttributeError:
                pass
        return False


def eos_token_id(model):
    """The first-codebook value that marks the end of speech, or None where the config does not say."""
    for owner in (model, getattr(model, "model", None)):
        config = getattr(owner, "config", None)
        talker = getattr(config, "talker_config", None)
        eos = getattr(talker, "codec_eos_token_id", None)
        if eos is not None:
            return int(eos)
    return None


def decode_codes(model, codes, ref_codes=None):
    """
    The audio for a run of frames, decoded the way the reference does it:
    a clone's reference codes in front, and their share of the audio cut
    off. The codec decoder is causal, so the audio for a prefix of the
    frames is the same audio the whole utterance decodes to over those
    frames, and each part can be handed out as soon as it is decoded.
    Returns (float32 samples, sample rate).
    """
    tokenizer = getattr(getattr(model, "model", model), "speech_tokenizer")
    full = codes if ref_codes is None else torch.cat([ref_codes.to(codes.device), codes], dim=0)
    wavs, sr = tokenizer.decode([{"audio_codes": full}])
    wav = wavs[0]
    if hasattr(wav, "detach"):
        wav = wav.detach().float().cpu().numpy()
    wav = wav.reshape(-1)
    if ref_codes is not None:
        cut = int(int(ref_codes.shape[0]) / max(int(full.shape[0]), 1) * wav.shape[0])
        wav = wav[cut:]
    return wav, int(sr)


def decoder_module(model):
    """The codec decoder as an nn.Module, for casting; raises when the runtime keeps it elsewhere."""
    tokenizer = getattr(getattr(model, "model", model), "speech_tokenizer")
    inner = getattr(tokenizer, "model", None)
    if inner is None or not hasattr(inner, "float"):
        raise AttributeError("speech_tokenizer.model")
    return inner
